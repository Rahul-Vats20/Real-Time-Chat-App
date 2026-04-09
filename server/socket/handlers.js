// socket/handlers.js - All Socket.io event handlers
const { query, withTransaction } = require('../db/postgres');
const {
  setUserOnline, setUserOffline, getUserPresence, getOnlineUsers,
  setTyping, clearTyping, getTypingUsers,
  cacheMessage, getCachedMessages,
  queueOfflineMessage, getOfflineMessages,
  publish, subscribe,
} = require('../db/redis');

const { socketRateLimit } = require('../middleware/rateLimiter');
const { runGuards } = require('./roomGuards');
const { createMentionNotifications, createMessageNotifications } = require('../routes/notifications');
const { getMessageReactions } = require('../routes/reactions');

// Track typing timeouts per socket
const typingTimeouts = new Map();

// =====================================================
// REGISTER ALL SOCKET HANDLERS
// =====================================================
const registerSocketHandlers = (io, socket, record = {}) => {
  const user = socket.user;
  console.log(`🔌 User connected: ${user.display_name} (${user.id}) | socket: ${socket.id}`);

  // ===================================================
  // CONNECTION & PRESENCE
  // ===================================================
  const handleConnect = async () => {
    try {
      // Mark user online in Redis
      await setUserOnline(user.id, socket.id);

      // Update status in PostgreSQL
      await query(
        'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
        ['online', user.id]
      );

      // Join all user's rooms
      const userRooms = await query(
        'SELECT room_id FROM room_members WHERE user_id = $1',
        [user.id]
      );

      for (const { room_id } of userRooms.rows) {
        socket.join(`room:${room_id}`);
      }

      // Deliver queued offline messages
      const offlineMessages = await getOfflineMessages(user.id);
      if (offlineMessages.length > 0) {
        socket.emit('offline_messages', { messages: offlineMessages });
        console.log(`📬 Delivered ${offlineMessages.length} offline messages to ${user.display_name}`);
      }

      // Broadcast presence to other users
      socket.broadcast.emit('user_status_change', {
        userId: user.id,
        status: 'online',
        lastSeen: new Date().toISOString(),
      });

      // Send current online users to this socket
      const onlineUserIds = await getOnlineUsers();
      socket.emit('online_users', { userIds: onlineUserIds });

    } catch (err) {
      console.error('[Socket] handleConnect error:', err);
    }
  };

  // ===================================================
  // JOIN / LEAVE ROOMS
  // ===================================================
  socket.on('join_room', async ({ roomId }) => {
    try {
      // Verify membership
      const member = await query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, user.id]
      );

      if (!member.rows.length) {
        return socket.emit('error', { event: 'join_room', message: 'Not a member of this room' });
      }

      socket.join(`room:${roomId}`);

      // Try cached messages first
      let messages = await getCachedMessages(roomId, 30);

      if (messages && messages.length > 0) {
        // Fetch read receipts for cached messages
        const msgIds = messages.map(m => m.id);
        const readsResult = await query(
          `SELECT message_id, json_agg(json_build_object('user_id', user_id, 'read_at', read_at)) as read_by
           FROM (
             SELECT message_id, user_id, read_at
             FROM message_reads
             WHERE message_id = ANY($1)
             ORDER BY read_at DESC
           ) mr
           GROUP BY message_id`,
           [msgIds]
        );
        const readsMap = {};
        readsResult.rows.forEach(r => {
          readsMap[r.message_id] = r.read_by.slice(0, 3);
        });
        messages.forEach(m => {
          m.read_by = readsMap[m.id] || [];
        });
      }

      // Fall back to PostgreSQL
      if (!messages) {
        const result = await query(
          `SELECT m.id, m.content, m.message_type, m.edited, m.deleted, m.created_at,
                  json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'avatar_url', u.avatar_url) as sender,
                  COALESCE((
                    SELECT json_agg(json_build_object('user_id', mr.user_id, 'read_at', mr.read_at))
                    FROM (
                      SELECT mr.user_id, mr.read_at FROM message_reads mr
                      WHERE mr.message_id = m.id
                      ORDER BY mr.read_at DESC LIMIT 3
                    ) mr
                  ), '[]') as read_by
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.room_id = $1 AND NOT m.deleted
           ORDER BY m.created_at DESC LIMIT 30`,
          [roomId]
        );
        messages = result.rows.reverse();
      }

      socket.emit('room_history', { roomId, messages });

      // Update last_read_at
      await query(
        'UPDATE room_members SET last_read_at = NOW() WHERE room_id = $1 AND user_id = $2',
        [roomId, user.id]
      );

    } catch (err) {
      console.error('[Socket] join_room error:', err);
      socket.emit('error', { event: 'join_room', message: 'Failed to join room' });
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    socket.leave(`room:${roomId}`);
  });

  // ===================================================
  // MESSAGES
  // ===================================================
  socket.on('send_message', async ({ roomId, content, messageType = 'text', replyTo = null }) => {
    try {
      if (!content?.trim()) {
        return socket.emit('error', { event: 'send_message', message: 'Message cannot be empty' });
      }

      // Rate limiting
      const rateCheck = socketRateLimit('message', user.id);
      if (!rateCheck.allowed) {
        return socket.emit('error', { event: 'send_message', message: `Slow down! Retry in ${rateCheck.retryAfter}s` });
      }

      // Verify room membership
      const member = await query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, user.id]
      );

      if (!member.rows.length) {
        return socket.emit('error', { event: 'send_message', message: 'Not a member of this room' });
      }

      // Run room guards (slow-mode, read-only, content length, word filter)
      const guard = await runGuards(roomId, user.id, content.trim());
      if (!guard.allowed) {
        return socket.emit('error', {
          event: 'send_message',
          message: guard.reason || (guard.waitSeconds ? `Slow mode: wait ${guard.waitSeconds}s` : 'Message blocked'),
          waitSeconds: guard.waitSeconds,
        });
      }

      // Persist message to PostgreSQL
      const result = await query(
        `INSERT INTO messages (room_id, sender_id, content, message_type, reply_to)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, room_id, content, message_type, reply_to, edited, created_at`,
        [roomId, user.id, content.trim(), messageType, replyTo]
      );

      const message = {
        ...result.rows[0],
        sender: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        },
        read_by: [],
      };

      // Cache in Redis
      await cacheMessage(roomId, message);

      // Clear typing indicator
      await clearTyping(roomId, user.id);
      clearTimeout(typingTimeouts.get(`${roomId}:${user.id}`));

      // Broadcast to room members
      io.to(`room:${roomId}`).emit('new_message', { message });

      // Record metric
      if (record.message) record.message();

      // Find offline members and queue
      const roomMembers = await query(
        `SELECT rm.user_id FROM room_members rm
         WHERE rm.room_id = $1 AND rm.user_id != $2`,
        [roomId, user.id]
      );

      for (const { user_id } of roomMembers.rows) {
        const presence = await getUserPresence(user_id);

        if (!presence || !presence.socketId) {
          // User is offline - queue the message
          await queueOfflineMessage(user_id, message);

          // Also persist to offline queue table
          await query(
            'INSERT INTO offline_message_queue (user_id, message_id) VALUES ($1, $2)',
            [user_id, message.id]
          );
        }
      }

      // Handle @mentions - create notifications + alert mentioned users
      try {
        const mentionedUserIds = await createMentionNotifications(message, roomId, user);
        for (const mentionedId of mentionedUserIds) {
          const presence = await getUserPresence(mentionedId);
          if (presence?.socketId) {
            const targetSocket = io.sockets.sockets.get(presence.socketId);
            if (targetSocket) {
              targetSocket.emit('notification', {
                type: 'mention',
                actor: { id: user.id, display_name: user.display_name },
                roomId,
                messageId: message.id,
                preview: message.content.slice(0, 100),
              });
            }
          }
        }
        
        // Handle normal message notifications for the rest
        await createMessageNotifications(message, roomId, user, mentionedUserIds);
      } catch (mentionErr) {
        console.error('[Socket] mention notification error:', mentionErr.message);
      }

    } catch (err) {
      console.error('[Socket] send_message error:', err);
      socket.emit('error', { event: 'send_message', message: 'Failed to send message' });
    }
  });

  // Edit message
  socket.on('edit_message', async ({ messageId, newContent }) => {
    try {
      if (!newContent?.trim()) {
        return socket.emit('error', { event: 'edit_message', message: 'Content cannot be empty' });
      }

      const result = await query(
        `UPDATE messages SET content = $1, edited = TRUE, edited_at = NOW()
         WHERE id = $2 AND sender_id = $3 AND NOT deleted
         RETURNING id, room_id, content, edited, edited_at`,
        [newContent.trim(), messageId, user.id]
      );

      if (!result.rows.length) {
        return socket.emit('error', { event: 'edit_message', message: 'Message not found or unauthorized' });
      }

      const updated = result.rows[0];
      io.to(`room:${updated.room_id}`).emit('message_edited', { message: updated });

    } catch (err) {
      console.error('[Socket] edit_message error:', err);
    }
  });

  // Delete message
  socket.on('delete_message', async ({ messageId }) => {
    try {
      const result = await query(
        `UPDATE messages SET deleted = TRUE, content = '[deleted]'
         WHERE id = $1 AND sender_id = $2
         RETURNING id, room_id`,
        [messageId, user.id]
      );

      if (!result.rows.length) {
        return socket.emit('error', { event: 'delete_message', message: 'Message not found or unauthorized' });
      }

      const { id, room_id } = result.rows[0];
      io.to(`room:${room_id}`).emit('message_deleted', { messageId: id, roomId: room_id });

    } catch (err) {
      console.error('[Socket] delete_message error:', err);
    }
  });

  // ===================================================
  // READ RECEIPTS
  // ===================================================
  socket.on('mark_read', async ({ roomId, messageId }) => {
    try {
      // Upsert read receipt
      await query(
        `INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2)
         ON CONFLICT (message_id, user_id) DO NOTHING`,
        [messageId, user.id]
      );

      // Update room last_read_at
      await query(
        'UPDATE room_members SET last_read_at = NOW() WHERE room_id = $1 AND user_id = $2',
        [roomId, user.id]
      );

      // Mark notifications as read
      await query(
        'UPDATE notifications SET read = TRUE WHERE room_id = $1 AND user_id = $2 AND NOT read',
        [roomId, user.id]
      );

      // Broadcast read receipt to room
      io.to(`room:${roomId}`).emit('message_read', {
        messageId,
        roomId,
        userId: user.id,
        username: user.username,
        display_name: user.display_name,
        readAt: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[Socket] mark_read error:', err);
    }
  });

  // ===================================================
  // TYPING INDICATORS
  // ===================================================
  socket.on('typing_start', async ({ roomId }) => {
    try {
      await setTyping(roomId, user.id, user.display_name);

      // Broadcast to other room members
      socket.to(`room:${roomId}`).emit('user_typing', {
        roomId,
        userId: user.id,
        username: user.username,
        display_name: user.display_name,
      });

      // Auto-clear typing after 5 seconds
      const key = `${roomId}:${user.id}`;
      clearTimeout(typingTimeouts.get(key));
      typingTimeouts.set(key, setTimeout(async () => {
        await clearTyping(roomId, user.id);
        socket.to(`room:${roomId}`).emit('user_stopped_typing', {
          roomId,
          userId: user.id,
        });
      }, 5000));

    } catch (err) {
      console.error('[Socket] typing_start error:', err);
    }
  });

  socket.on('typing_stop', async ({ roomId }) => {
    try {
      await clearTyping(roomId, user.id);

      const key = `${roomId}:${user.id}`;
      clearTimeout(typingTimeouts.get(key));
      typingTimeouts.delete(key);

      socket.to(`room:${roomId}`).emit('user_stopped_typing', {
        roomId,
        userId: user.id,
      });
    } catch (err) {
      console.error('[Socket] typing_stop error:', err);
    }
  });

  // ===================================================
  // GROUP MANAGEMENT
  // ===================================================
  socket.on('add_member', async ({ roomId, userId }) => {
    try {
      // Check if requester is admin
      const adminCheck = await query(
        `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2 AND role = 'admin'`,
        [roomId, user.id]
      );

      if (!adminCheck.rows.length) {
        return socket.emit('error', { event: 'add_member', message: 'Only admins can add members' });
      }

      await query(
        'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [roomId, userId, 'member']
      );

      // Join their socket to the room if online
      const presence = await getUserPresence(userId);
      if (presence?.socketId) {
        const targetSocket = io.sockets.sockets.get(presence.socketId);
        if (targetSocket) {
          targetSocket.join(`room:${roomId}`);
          targetSocket.emit('added_to_room', { roomId });
        }
      }

      const newMember = await query(
        'SELECT id, username, display_name, avatar_url, status FROM users WHERE id = $1',
        [userId]
      );

      io.to(`room:${roomId}`).emit('member_added', {
        roomId,
        member: newMember.rows[0],
        addedBy: user.display_name,
      });

    } catch (err) {
      console.error('[Socket] add_member error:', err);
    }
  });

  socket.on('remove_member', async ({ roomId, userId }) => {
    try {
      const adminCheck = await query(
        `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2 AND role = 'admin'`,
        [roomId, user.id]
      );

      if (!adminCheck.rows.length && userId !== user.id) {
        return socket.emit('error', { event: 'remove_member', message: 'Only admins can remove members' });
      }

      await query(
        'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
      );

      io.to(`room:${roomId}`).emit('member_removed', {
        roomId,
        userId,
        removedBy: user.display_name,
      });

      // Remove from room if online
      const presence = await getUserPresence(userId);
      if (presence?.socketId) {
        const targetSocket = io.sockets.sockets.get(presence.socketId);
        if (targetSocket) targetSocket.leave(`room:${roomId}`);
      }

    } catch (err) {
      console.error('[Socket] remove_member error:', err);
    }
  });

  // ===================================================
  // STATUS UPDATES
  // ===================================================
  socket.on('update_status', async ({ status }) => {
    try {
      const validStatuses = ['online', 'away', 'busy', 'offline'];
      if (!validStatuses.includes(status)) return;

      await query(
        'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
        [status, user.id]
      );

      socket.broadcast.emit('user_status_change', {
        userId: user.id,
        status,
        lastSeen: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[Socket] update_status error:', err);
    }
  });

  // ===================================================
  // ROOM SETTINGS (real-time updates)
  // ===================================================
  socket.on('update_room_settings', async ({ roomId, settings }) => {
    try {
      const { updateRoomSettings } = require('../routes/roomSettings');
      await updateRoomSettings(roomId, user.id, settings, io);
    } catch (err) {
      socket.emit('error', { event: 'update_room_settings', message: err.message });
    }
  });

  // ===================================================
  // REACTIONS
  // ===================================================
  socket.on('toggle_reaction', async ({ messageId, emoji }) => {
    try {
      const ALLOWED = new Set(['👍','👎','❤️','😂','😮','😢','😡','🎉','🔥','✅','❌','💯','🚀','👀','💡']);
      if (!ALLOWED.has(emoji)) return;

      const access = await query(
        `SELECT m.room_id FROM messages m
         JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
         WHERE m.id = $2`,
        [user.id, messageId]
      );
      if (!access.rows.length) return;
      const roomId = access.rows[0].room_id;

      const existing = await query(
        'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, user.id, emoji]
      );

      if (existing.rows.length) {
        await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, user.id, emoji]);
      } else {
        await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, user.id, emoji]);
      }

      const reactions = await getMessageReactions(messageId);
      io.to(`room:${roomId}`).emit('reaction_updated', { messageId, roomId, reactions });

    } catch (err) {
      console.error('[Socket] toggle_reaction error:', err);
    }
  });

  // ===================================================
  // DISCONNECT
  // ===================================================
  socket.on('disconnect', async (reason) => {
    console.log(`🔌 User disconnected: ${user.display_name} | reason: ${reason}`);
    if (record.disconnect) record.disconnect();

    try {
      // Clear all typing timeouts
      for (const [key, timeout] of typingTimeouts.entries()) {
        if (key.endsWith(`:${user.id}`)) {
          clearTimeout(timeout);
          typingTimeouts.delete(key);
        }
      }

      // Mark offline in Redis
      await setUserOffline(user.id);

      // Update PostgreSQL
      await query(
        'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
        ['offline', user.id]
      );

      // Notify others
      socket.broadcast.emit('user_status_change', {
        userId: user.id,
        status: 'offline',
        lastSeen: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[Socket] disconnect error:', err);
    }
  });

  // Run connection setup
  handleConnect();
};

module.exports = { registerSocketHandlers };

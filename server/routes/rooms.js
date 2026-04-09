// routes/rooms.js - Room management endpoints
const express = require('express');
const { query, withTransaction } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /rooms - Get all rooms for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         r.id, r.name, r.description, r.room_type, r.is_private, r.avatar_url,
         r.created_at, r.updated_at,
         rm.role, rm.last_read_at,
         -- Last message preview
         (SELECT json_build_object(
           'id', m.id,
           'content', m.content,
           'sender_name', u.display_name,
           'created_at', m.created_at
         )
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.room_id = r.id AND NOT m.deleted
         ORDER BY m.created_at DESC LIMIT 1) as last_message,
         -- Unread count
         (SELECT COUNT(*)::int FROM messages m
          WHERE m.room_id = r.id
          AND m.created_at > rm.last_read_at
          AND m.sender_id != $1
          AND NOT m.deleted) as unread_count,
         -- Member count
         (SELECT COUNT(*)::int FROM room_members WHERE room_id = r.id) as member_count
       FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.user_id = $1
       ORDER BY COALESCE((
         SELECT m.created_at FROM messages m
         WHERE m.room_id = r.id ORDER BY m.created_at DESC LIMIT 1
       ), r.created_at) DESC`,
      [req.user.userId]
    );

    res.json({ rooms: result.rows });
  } catch (err) {
    console.error('[Rooms] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// GET /rooms/:id - Get single room with members
router.get('/:id', requireAuth, async (req, res) => {
  try {
    // Check membership
    const memberCheck = await query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const roomResult = await query(
      'SELECT * FROM rooms WHERE id = $1',
      [req.params.id]
    );

    if (!roomResult.rows.length) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const membersResult = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, u.last_seen,
              rm.role, rm.joined_at
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY rm.role DESC, u.display_name`,
      [req.params.id]
    );

    res.json({
      room: roomResult.rows[0],
      members: membersResult.rows,
    });
  } catch (err) {
    console.error('[Rooms] GET /:id error:', err);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// POST /rooms - Create new group room
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, memberIds = [], isPrivate = false } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Room name is required' });
    }

    const room = await withTransaction(async (client) => {
      // Create room
      const roomResult = await client.query(
        `INSERT INTO rooms (name, description, room_type, is_private, created_by)
         VALUES ($1, $2, 'group', $3, $4)
         RETURNING *`,
        [name.trim(), description || null, isPrivate, req.user.userId]
      );
      const newRoom = roomResult.rows[0];

      // Add creator as admin
      await client.query(
        'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
        [newRoom.id, req.user.userId, 'admin']
      );

      // Add other members
      for (const memberId of memberIds) {
        if (memberId !== req.user.userId) {
          await client.query(
            'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [newRoom.id, memberId, 'member']
          );
        }
      }

      return newRoom;
    });

    res.status(201).json({ room });
  } catch (err) {
    console.error('[Rooms] POST / error:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// POST /rooms/direct - Create or get DM room
router.post('/direct', requireAuth, async (req, res) => {
  try {
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId required' });
    }

    // Check if DM already exists between these two users
    const existing = await query(
      `SELECT r.* FROM rooms r
       JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = $1
       JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = $2
       WHERE r.room_type = 'direct'
       AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2`,
      [req.user.userId, targetUserId]
    );

    if (existing.rows.length) {
      return res.json({ room: existing.rows[0], existing: true });
    }

    // Get target user info for room name
    const targetUser = await query(
      'SELECT id, display_name FROM users WHERE id = $1',
      [targetUserId]
    );

    if (!targetUser.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const room = await withTransaction(async (client) => {
      const roomResult = await client.query(
        `INSERT INTO rooms (name, room_type, created_by)
         VALUES ($1, 'direct', $2)
         RETURNING *`,
        [`DM:${req.user.userId}:${targetUserId}`, req.user.userId]
      );
      const newRoom = roomResult.rows[0];

      await client.query(
        'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $3)',
        [newRoom.id, req.user.userId, 'member', targetUserId]
      );

      return newRoom;
    });

    res.status(201).json({ room, existing: false });
  } catch (err) {
    console.error('[Rooms] POST /direct error:', err);
    res.status(500).json({ error: 'Failed to create DM' });
  }
});

// GET /rooms/:id/messages - Paginated message history
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const { before, limit = 50 } = req.query;

    // Verify membership
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const params = [req.params.id, Math.min(parseInt(limit), 100)];
    let cursorClause = '';

    if (before) {
      params.push(before);
      cursorClause = `AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
    }

    const result = await query(
      `SELECT
         m.id, m.content, m.message_type, m.reply_to, m.edited, m.edited_at,
         m.deleted, m.metadata, m.created_at,
         json_build_object(
           'id', u.id,
           'username', u.username,
           'display_name', u.display_name,
           'avatar_url', u.avatar_url
         ) as sender,
         -- Read receipts (latest 3 readers)
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
       WHERE m.room_id = $1
       ${cursorClause}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      params
    );

    // Update last_read_at for this user in this room
    await query(
      'UPDATE room_members SET last_read_at = NOW() WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    res.json({
      messages: result.rows.reverse(),
      hasMore: result.rows.length === parseInt(limit),
    });
  } catch (err) {
    console.error('[Rooms] GET /:id/messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// PATCH /rooms/:id/read - Mark room as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE room_members SET last_read_at = NOW() WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    await query(
      'UPDATE notifications SET read = TRUE WHERE room_id = $1 AND user_id = $2 AND NOT read',
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

module.exports = router;

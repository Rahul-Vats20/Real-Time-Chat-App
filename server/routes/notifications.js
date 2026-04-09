// routes/notifications.js - User notification management
const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications - Get user's notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const { limit = 30, unreadOnly = false } = req.query;

    const result = await query(
      `SELECT
         n.id, n.type, n.read, n.created_at,
         n.metadata,
         json_build_object(
           'id', u.id, 'username', u.username,
           'display_name', u.display_name, 'avatar_url', u.avatar_url
         ) as actor,
         json_build_object('id', r.id, 'name', r.name) as room
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN rooms r ON r.id = n.room_id
       WHERE n.user_id = $1
         ${unreadOnly === 'true' ? 'AND NOT n.read' : ''}
       ORDER BY n.created_at DESC
       LIMIT $2`,
      [req.user.userId, Math.min(parseInt(limit), 100)]
    );

    // Unread count
    const countResult = await query(
      'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND NOT read',
      [req.user.userId]
    );

    res.json({
      notifications: result.rows,
      unreadCount: countResult.rows[0].count,
    });
  } catch (err) {
    console.error('[Notifications] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/notifications/read-all - Mark all as read
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND NOT read',
      [req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Utility: Parse @mentions from message content
function extractMentions(content) {
  const mentionRegex = /@([a-zA-Z0-9_]+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1].toLowerCase());
  }
  return [...new Set(mentions)]; // dedupe
}

// Utility: Create mention notifications (called from socket handlers)
async function createMentionNotifications(message, roomId, senderUser) {
  const mentions = extractMentions(message.content);
  if (!mentions.length) return [];

  // Find mentioned users who are room members
  const result = await query(
    `SELECT u.id, u.username FROM users u
     JOIN room_members rm ON rm.room_id = $1 AND rm.user_id = u.id
     WHERE LOWER(u.username) = ANY($2::text[])
       AND u.id != $3`,
    [roomId, mentions, senderUser.id]
  );

  const notifs = [];
  for (const mentioned of result.rows) {
    await query(
      `INSERT INTO notifications (user_id, type, actor_id, room_id, metadata)
       VALUES ($1, 'mention', $2, $3, $4)`,
      [
        mentioned.id,
        senderUser.id,
        roomId,
        JSON.stringify({ messageId: message.id, preview: message.content.slice(0, 100) }),
      ]
    );
    notifs.push(mentioned.id);
  }

  return notifs; // array of notified user IDs
}
// Utility: Create message notifications (for unmentioned users)
async function createMessageNotifications(message, roomId, senderUser, excludeIds = []) {
  // Find members who are not the sender and not in excludeIds
  const result = await query(
    `SELECT u.id FROM users u
     JOIN room_members rm ON rm.room_id = $1 AND rm.user_id = u.id
     WHERE u.id != $2 AND NOT (u.id = ANY($3::uuid[]))`,
    [roomId, senderUser.id, excludeIds]
  );

  const notifs = [];
  for (const row of result.rows) {
    await query(
      `INSERT INTO notifications (user_id, type, actor_id, room_id, metadata)
       VALUES ($1, 'message', $2, $3, $4)`,
      [
        row.id,
        senderUser.id,
        roomId,
        JSON.stringify({ messageId: message.id, preview: message.content.slice(0, 100) }),
      ]
    );
    notifs.push(row.id);
  }

  return notifs;
}

module.exports = router;
module.exports.extractMentions = extractMentions;
module.exports.createMentionNotifications = createMentionNotifications;
module.exports.createMessageNotifications = createMessageNotifications;

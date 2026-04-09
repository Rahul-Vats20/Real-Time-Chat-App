// routes/threads.js — Message threading & pinned messages
const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/threads/:messageId — Get a message + its replies ──
router.get('/:messageId', requireAuth, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Get the root message
    const root = await query(
      `SELECT m.id, m.content, m.room_id, m.message_type, m.edited,
              m.deleted, m.created_at, m.reply_to,
              json_build_object(
                'id', u.id, 'username', u.username,
                'display_name', u.display_name, 'avatar_url', u.avatar_url
              ) as sender,
              (SELECT COUNT(*)::int FROM messages WHERE reply_to = m.id AND NOT deleted) as reply_count
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [messageId]
    );

    if (!root.rows.length) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const rootMsg = root.rows[0];

    // Verify user is room member
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [rootMsg.room_id, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all replies (max 2 levels deep for simplicity)
    const replies = await query(
      `SELECT m.id, m.content, m.room_id, m.message_type, m.reply_to,
              m.edited, m.deleted, m.created_at,
              json_build_object(
                'id', u.id, 'username', u.username,
                'display_name', u.display_name, 'avatar_url', u.avatar_url
              ) as sender,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', emoji, 'count', cnt))
                FROM (
                  SELECT emoji, COUNT(*)::int as cnt
                  FROM message_reactions WHERE message_id = m.id
                  GROUP BY emoji ORDER BY cnt DESC
                ) r
              ), '[]') as reactions
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.reply_to = $1 AND NOT m.deleted
       ORDER BY m.created_at ASC`,
      [messageId]
    );

    res.json({
      root: rootMsg,
      replies: replies.rows,
      replyCount: replies.rows.length,
    });
  } catch (err) {
    console.error('[Threads] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// ── GET /api/threads/room/:roomId — All threads in a room ──
router.get('/room/:roomId', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 20 } = req.query;

    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Messages that have at least one reply (thread starters)
    const result = await query(
      `SELECT m.id, m.content, m.created_at,
              json_build_object(
                'id', u.id, 'username', u.username,
                'display_name', u.display_name
              ) as sender,
              COUNT(r.id)::int as reply_count,
              MAX(r.created_at) as last_reply_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN messages r ON r.reply_to = m.id AND NOT r.deleted
       WHERE m.room_id = $1 AND m.reply_to IS NULL AND NOT m.deleted
       GROUP BY m.id, u.id
       HAVING COUNT(r.id) > 0
       ORDER BY last_reply_at DESC
       LIMIT $2`,
      [roomId, Math.min(parseInt(limit), 50)]
    );

    res.json({ threads: result.rows });
  } catch (err) {
    console.error('[Threads] room threads error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── GET /api/threads/pinned/:roomId — Get pinned messages ──
router.get('/pinned/:roomId', requireAuth, async (req, res) => {
  try {
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await query(
      `SELECT pm.id as pin_id, pm.pinned_at,
              json_build_object('id', pinner.id, 'display_name', pinner.display_name) as pinned_by,
              json_build_object(
                'id', m.id, 'content', m.content, 'created_at', m.created_at,
                'sender', json_build_object(
                  'id', u.id, 'username', u.username,
                  'display_name', u.display_name, 'avatar_url', u.avatar_url
                )
              ) as message
       FROM pinned_messages pm
       JOIN messages m ON m.id = pm.message_id
       JOIN users u ON u.id = m.sender_id
       JOIN users pinner ON pinner.id = pm.pinned_by
       WHERE pm.room_id = $1
       ORDER BY pm.pinned_at DESC`,
      [req.params.roomId]
    );

    res.json({ pins: result.rows });
  } catch (err) {
    console.error('[Threads] GET pinned error:', err);
    res.status(500).json({ error: 'Failed to fetch pinned messages' });
  }
});

// ── POST /api/threads/pin — Pin a message (admins/mods) ──
router.post('/pin', requireAuth, async (req, res) => {
  try {
    const { messageId, roomId } = req.body;
    if (!messageId || !roomId) {
      return res.status(400).json({ error: 'messageId and roomId required' });
    }

    const memberCheck = await query(
      `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2
       AND role IN ('admin', 'moderator')`,
      [roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Only admins and moderators can pin messages' });
    }

    await query(
      `INSERT INTO pinned_messages (room_id, message_id, pinned_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [roomId, messageId, req.user.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Threads] pin error:', err);
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

// ── DELETE /api/threads/pin/:pinId — Unpin ──
router.delete('/pin/:pinId', requireAuth, async (req, res) => {
  try {
    // Must be room admin/mod to unpin
    const pin = await query(
      `SELECT pm.room_id FROM pinned_messages pm
       JOIN room_members rm ON rm.room_id = pm.room_id AND rm.user_id = $1
       WHERE pm.id = $2 AND rm.role IN ('admin', 'moderator')`,
      [req.user.userId, req.params.pinId]
    );

    if (!pin.rows.length) {
      return res.status(403).json({ error: 'Not authorised to unpin' });
    }

    await query('DELETE FROM pinned_messages WHERE id = $1', [req.params.pinId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unpin message' });
  }
});

module.exports = router;

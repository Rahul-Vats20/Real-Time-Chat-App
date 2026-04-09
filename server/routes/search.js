// routes/search.js - Full-text message and user search
const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/search/messages?q=hello&roomId=...&limit=20
router.get('/messages', requireAuth, async (req, res) => {
  try {
    const { q, roomId, limit = 20, before } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const params = [req.user.userId, q.trim(), Math.min(parseInt(limit), 50)];
    let roomFilter = '';
    let cursorFilter = '';

    if (roomId) {
      params.push(roomId);
      roomFilter = `AND m.room_id = $${params.length}`;
    }

    if (before) {
      params.push(before);
      cursorFilter = `AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
    }

    const result = await query(
      `SELECT
         m.id, m.content, m.created_at, m.room_id,
         json_build_object(
           'id', u.id, 'username', u.username,
           'display_name', u.display_name, 'avatar_url', u.avatar_url
         ) as sender,
         json_build_object('id', r.id, 'name', r.name, 'room_type', r.room_type) as room,
         -- Highlight matched terms (basic)
         ts_headline('english', m.content,
           plainto_tsquery('english', $2),
           'StartSel=<mark>,StopSel=</mark>,MaxWords=20,MinWords=5'
         ) as highlighted
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN rooms r ON r.id = m.room_id
       JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
       WHERE NOT m.deleted
         AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $2)
         ${roomFilter}
         ${cursorFilter}
       ORDER BY m.created_at DESC
       LIMIT $3`,
      params
    );

    res.json({
      query: q,
      results: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('[Search] messages error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/users?q=alice
router.get('/users', requireAuth, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q || q.trim().length < 1) {
      return res.status(400).json({ error: 'Query required' });
    }

    const result = await query(
      `SELECT id, username, display_name, avatar_url, status
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1)
         AND id != $2
       ORDER BY
         CASE WHEN username = $3 THEN 0
              WHEN username ILIKE $3 || '%' THEN 1
              ELSE 2 END,
         display_name
       LIMIT $4`,
      [`%${q.trim()}%`, req.user.userId, q.trim().toLowerCase(), Math.min(parseInt(limit), 20)]
    );

    res.json({ results: result.rows });
  } catch (err) {
    console.error('[Search] users error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/rooms?q=general
router.get('/rooms', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: 'Query required' });

    const result = await query(
      `SELECT r.id, r.name, r.description, r.room_type,
              COUNT(rm2.user_id)::int as member_count,
              EXISTS(SELECT 1 FROM room_members WHERE room_id = r.id AND user_id = $1) as is_member
       FROM rooms r
       JOIN room_members rm2 ON rm2.room_id = r.id
       WHERE r.name ILIKE $2 AND r.room_type = 'group' AND NOT r.is_private
       GROUP BY r.id
       ORDER BY member_count DESC
       LIMIT 20`,
      [req.user.userId, `%${q.trim()}%`]
    );

    res.json({ results: result.rows });
  } catch (err) {
    console.error('[Search] rooms error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;

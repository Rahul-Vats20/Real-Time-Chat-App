// routes/reactions.js - Emoji reactions on messages
const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_REACTIONS = new Set([
  '👍','👎','❤️','😂','😮','😢','😡','🎉','🔥','✅','❌','💯','🚀','👀','💡'
]);

// POST /api/reactions - Toggle a reaction
router.post('/', requireAuth, async (req, res) => {
  try {
    const { messageId, emoji } = req.body;

    if (!messageId || !emoji) {
      return res.status(400).json({ error: 'messageId and emoji required' });
    }

    if (!ALLOWED_REACTIONS.has(emoji)) {
      return res.status(400).json({ error: 'Emoji not allowed' });
    }

    // Verify user can access this message (is member of room)
    const access = await query(
      `SELECT m.room_id FROM messages m
       JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
       WHERE m.id = $2`,
      [req.user.userId, messageId]
    );

    if (!access.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const roomId = access.rows[0].room_id;

    // Toggle: if exists, remove; otherwise add
    const existing = await query(
      'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.user.userId, emoji]
    );

    let action;
    if (existing.rows.length) {
      await query(
        'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, req.user.userId, emoji]
      );
      action = 'removed';
    } else {
      await query(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, req.user.userId, emoji]
      );
      action = 'added';
    }

    // Get updated reactions for this message
    const reactions = await getMessageReactions(messageId);

    res.json({ action, messageId, roomId, emoji, reactions });
  } catch (err) {
    console.error('[Reactions] POST error:', err);
    res.status(500).json({ error: 'Failed to update reaction' });
  }
});

// GET /api/reactions/:messageId
router.get('/:messageId', requireAuth, async (req, res) => {
  try {
    const reactions = await getMessageReactions(req.params.messageId);
    res.json({ reactions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

async function getMessageReactions(messageId) {
  const result = await query(
    `SELECT
       emoji,
       COUNT(*)::int as count,
       json_agg(json_build_object('id', u.id, 'display_name', u.display_name)) as users
     FROM message_reactions mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = $1
     GROUP BY emoji
     ORDER BY count DESC`,
    [messageId]
  );
  return result.rows;
}

module.exports = router;
module.exports.getMessageReactions = getMessageReactions;

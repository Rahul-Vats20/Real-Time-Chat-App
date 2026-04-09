// routes/drafts.js — Message drafts & scheduled messages
const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── DRAFTS ─────────────────────────────────────────────────

// GET /api/drafts — Get all drafts for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT d.id, d.content, d.created_at, d.updated_at,
              json_build_object('id', r.id, 'name', r.name, 'room_type', r.room_type) as room
       FROM message_drafts d
       JOIN rooms r ON r.id = d.room_id
       WHERE d.user_id = $1
       ORDER BY d.updated_at DESC`,
      [req.user.userId]
    );
    res.json({ drafts: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
});

// PUT /api/drafts/:roomId — Upsert draft for a room
router.put('/:roomId', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;

    // Verify room membership
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Not a room member' });
    }

    if (!content?.trim()) {
      // Empty draft = delete it
      await query(
        'DELETE FROM message_drafts WHERE room_id = $1 AND user_id = $2',
        [req.params.roomId, req.user.userId]
      );
      return res.json({ deleted: true });
    }

    const result = await query(
      `INSERT INTO message_drafts (room_id, user_id, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, user_id) DO UPDATE
         SET content = $3, updated_at = NOW()
       RETURNING *`,
      [req.params.roomId, req.user.userId, content.trim()]
    );

    res.json({ draft: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// DELETE /api/drafts/:roomId — Delete draft
router.delete('/:roomId', requireAuth, async (req, res) => {
  try {
    await query(
      'DELETE FROM message_drafts WHERE room_id = $1 AND user_id = $2',
      [req.params.roomId, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// ── SCHEDULED MESSAGES ─────────────────────────────────────

// GET /api/drafts/scheduled — List scheduled messages
router.get('/scheduled', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.id, s.content, s.scheduled_at, s.status, s.created_at,
              json_build_object('id', r.id, 'name', r.name) as room
       FROM scheduled_messages s
       JOIN rooms r ON r.id = s.room_id
       WHERE s.user_id = $1 AND s.status = 'pending'
       ORDER BY s.scheduled_at ASC`,
      [req.user.userId]
    );
    res.json({ scheduled: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scheduled messages' });
  }
});

// POST /api/drafts/scheduled — Schedule a message
router.post('/scheduled', requireAuth, async (req, res) => {
  try {
    const { roomId, content, scheduledAt } = req.body;

    if (!roomId || !content?.trim() || !scheduledAt) {
      return res.status(400).json({ error: 'roomId, content, and scheduledAt required' });
    }

    const sendAt = new Date(scheduledAt);
    if (isNaN(sendAt) || sendAt <= new Date()) {
      return res.status(400).json({ error: 'scheduledAt must be a future date' });
    }

    const maxFuture = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days max
    if (sendAt > maxFuture) {
      return res.status(400).json({ error: 'Cannot schedule more than 30 days in advance' });
    }

    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Not a room member' });
    }

    const result = await query(
      `INSERT INTO scheduled_messages (room_id, user_id, content, scheduled_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [roomId, req.user.userId, content.trim(), sendAt]
    );

    res.status(201).json({ scheduled: result.rows[0] });
  } catch (err) {
    console.error('[Drafts] schedule error:', err);
    res.status(500).json({ error: 'Failed to schedule message' });
  }
});

// DELETE /api/drafts/scheduled/:id — Cancel scheduled message
router.delete('/scheduled/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE scheduled_messages SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.id, req.user.userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Scheduled message not found or already sent' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel scheduled message' });
  }
});

// ── SCHEDULER (runs every 30s) ─────────────────────────────
// Call startScheduler(io) from index.js after server starts
function startScheduler(io) {
  let tableExists = null; // cache result to avoid repeated checks

  const tick = async () => {
    try {
      // On first run, verify the table exists (migrations may not have run)
      if (tableExists === null) {
        const check = await query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_name = 'scheduled_messages' LIMIT 1`
        );
        tableExists = check.rows.length > 0;
        if (!tableExists) return; // silently wait for migrations
      }
      if (!tableExists) return;

      const due = await query(
        `UPDATE scheduled_messages SET status = 'sent'
         WHERE status = 'pending' AND scheduled_at <= NOW()
         RETURNING id, room_id, user_id, content`
      );

      for (const msg of due.rows) {
        const result = await query(
          `INSERT INTO messages (room_id, sender_id, content, message_type)
           VALUES ($1, $2, $3, 'text')
           RETURNING id, room_id, content, message_type, created_at`,
          [msg.room_id, msg.user_id, msg.content]
        );

        const sender = await query(
          'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
          [msg.user_id]
        );

        const message = {
          ...result.rows[0],
          sender: sender.rows[0],
          read_by: [],
        };

        io.to(`room:${msg.room_id}`).emit('new_message', { message });
        console.log(`📅 Delivered scheduled message ${msg.id} to room ${msg.room_id}`);
      }
    } catch (err) {
      if (err.message && err.message.includes('does not exist')) {
        tableExists = null; // reset so we re-check next tick
      } else {
        console.error('[Scheduler] tick error:', err.message);
      }
    }
  };

  const interval = setInterval(tick, 30_000);
  tick(); // run immediately on start

  console.log('⏰ Message scheduler started (30s interval)');
  return () => clearInterval(interval);
}

module.exports = router;
module.exports.startScheduler = startScheduler;

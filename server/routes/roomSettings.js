// routes/roomSettings.js — Room settings management
// Admins can configure: topic, icon, slow-mode, read-only toggle.
// Changes are broadcast to all room members via Socket.io.

const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/room-settings/:roomId ────────────────────────
router.get('/:roomId', requireAuth, async (req, res) => {
  try {
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Not a member' });
    }

    // Upsert default settings if they don't exist
    await query(
      `INSERT INTO room_settings (room_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [req.params.roomId]
    );

    const result = await query(
      `SELECT rs.*, r.name, r.description, r.is_private
       FROM room_settings rs
       JOIN rooms r ON r.id = rs.room_id
       WHERE rs.room_id = $1`,
      [req.params.roomId]
    );

    res.json({ settings: result.rows[0] || {} });
  } catch (err) {
    console.error('[RoomSettings] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PATCH /api/room-settings/:roomId ─────────────────────
// Exported so socket handlers can call it too
async function updateRoomSettings(roomId, userId, updates, io) {
  // Admin check
  const adminCheck = await query(
    `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2
     AND role IN ('admin', 'moderator')`,
    [roomId, userId]
  );
  if (!adminCheck.rows.length) {
    throw Object.assign(new Error('Admin or moderator required'), { status: 403 });
  }

  const allowed = ['topic', 'icon', 'slow_mode_seconds', 'read_only'];
  const fields = [];
  const vals = [];
  let i = 1;

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    if (k === 'slow_mode_seconds') {
      const s = parseInt(v);
      if (isNaN(s) || s < 0 || s > 3600) {
        throw Object.assign(new Error('slow_mode_seconds must be 0–3600'), { status: 400 });
      }
    }
    if (k === 'icon' && v && !/^\p{Emoji}/u.test(v)) {
      throw Object.assign(new Error('icon must be a single emoji'), { status: 400 });
    }
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }

  if (!fields.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  // Also update rooms table for name/description/is_private
  const roomFields = [];
  const roomVals = [];
  let ri = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (['name', 'description', 'is_private'].includes(k)) {
      roomFields.push(`${k} = $${ri++}`);
      roomVals.push(v);
    }
  }

  if (roomFields.length) {
    roomVals.push(roomId);
    await query(
      `UPDATE rooms SET ${roomFields.join(', ')}, updated_at = NOW() WHERE id = $${ri}`,
      roomVals
    );
  }

  vals.push(roomId);
  const result = await query(
    `INSERT INTO room_settings (room_id, ${fields.map((f, idx) => f.split(' ')[0]).join(', ')})
     VALUES ($${vals.length}, ${fields.map((_, idx) => `$${idx + 1}`).join(', ')})
     ON CONFLICT (room_id) DO UPDATE SET ${fields.join(', ')}, updated_at = NOW()
     RETURNING *`,
    vals
  );

  const settings = result.rows[0];

  // Broadcast to room
  if (io) {
    io.to(`room:${roomId}`).emit('room_settings_updated', {
      roomId,
      settings,
      updatedBy: userId,
    });
  }

  return settings;
}

router.patch('/:roomId', requireAuth, async (req, res) => {
  try {
    // io attached by index.js via app.set('io', io)
    const io = req.app.get('io');
    const settings = await updateRoomSettings(
      req.params.roomId,
      req.user.userId,
      req.body,
      io
    );
    res.json({ settings });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/room-settings/:roomId/pins ───────────────────
router.get('/:roomId/pins', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT pm.id, pm.pinned_at,
              json_build_object('id', u.id, 'display_name', u.display_name) as pinned_by,
              json_build_object(
                'id', m.id, 'content', m.content, 'created_at', m.created_at,
                'sender', json_build_object('id', su.id, 'display_name', su.display_name)
              ) as message
       FROM pinned_messages pm
       JOIN messages m ON m.id = pm.message_id
       JOIN users u ON u.id = pm.pinned_by
       JOIN users su ON su.id = m.sender_id
       WHERE pm.room_id = $1
       ORDER BY pm.pinned_at DESC`,
      [req.params.roomId]
    );
    res.json({ pins: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pins' });
  }
});

module.exports = router;
module.exports.updateRoomSettings = updateRoomSettings;

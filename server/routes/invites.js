// routes/invites.js — Room invite link system
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Invites live in a simple in-memory + DB combo
// In production: use a dedicated invites table (included in schema below)

// ── POST /api/invites — Create an invite link ──────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { roomId, maxUses = 10, expiresInHours = 24 } = req.body;

    if (!roomId) return res.status(400).json({ error: 'roomId required' });

    // Must be room member (any role can invite)
    const memberCheck = await query(
      'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'You must be a room member to create invites' });
    }

    const room = await query(
      'SELECT id, name, is_private FROM rooms WHERE id = $1',
      [roomId]
    );
    if (!room.rows.length) return res.status(404).json({ error: 'Room not found' });

    const token = crypto.randomBytes(8).toString('base64url');
    const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);

    await query(
      `INSERT INTO room_invites (token, room_id, created_by, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, roomId, req.user.userId, maxUses, expiresAt]
    );

    const inviteUrl = `${req.protocol}://${req.get('host')}/join/${token}`;

    res.status(201).json({
      token,
      inviteUrl,
      roomName: room.rows[0].name,
      maxUses,
      expiresAt,
    });
  } catch (err) {
    console.error('[Invites] POST error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// ── GET /api/invites/:token — Preview invite (no auth needed) ──
router.get('/:token', async (req, res) => {
  try {
    const invite = await query(
      `SELECT ri.token, ri.max_uses, ri.uses, ri.expires_at,
              r.id as room_id, r.name as room_name, r.description,
              r.room_type, COUNT(rm.user_id)::int as member_count,
              u.display_name as created_by_name
       FROM room_invites ri
       JOIN rooms r ON r.id = ri.room_id
       JOIN users u ON u.id = ri.created_by
       LEFT JOIN room_members rm ON rm.room_id = r.id
       WHERE ri.token = $1
         AND ri.expires_at > NOW()
         AND (ri.max_uses = 0 OR ri.uses < ri.max_uses)
       GROUP BY ri.token, ri.max_uses, ri.uses, ri.expires_at,
                r.id, r.name, r.description, r.room_type, u.display_name`,
      [req.params.token]
    );

    if (!invite.rows.length) {
      return res.status(404).json({ error: 'Invite not found or expired' });
    }

    res.json({ invite: invite.rows[0] });
  } catch (err) {
    console.error('[Invites] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch invite' });
  }
});

// ── POST /api/invites/:token/accept — Join via invite ──────
router.post('/:token/accept', requireAuth, async (req, res) => {
  try {
    // Fetch and validate invite
    const inviteResult = await query(
      `SELECT ri.room_id, ri.max_uses, ri.uses, ri.expires_at
       FROM room_invites ri
       WHERE ri.token = $1
         AND ri.expires_at > NOW()
         AND (ri.max_uses = 0 OR ri.uses < ri.max_uses)`,
      [req.params.token]
    );

    if (!inviteResult.rows.length) {
      return res.status(404).json({ error: 'Invite not found or expired' });
    }

    const { room_id } = inviteResult.rows[0];

    // Add user to room (idempotent)
    await query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [room_id, req.user.userId]
    );

    // Increment use count
    await query(
      'UPDATE room_invites SET uses = uses + 1 WHERE token = $1',
      [req.params.token]
    );

    const room = await query('SELECT id, name, room_type FROM rooms WHERE id = $1', [room_id]);

    res.json({ success: true, room: room.rows[0] });
  } catch (err) {
    console.error('[Invites] accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ── GET /api/invites/room/:roomId — List invites for a room ──
router.get('/room/:roomId', requireAuth, async (req, res) => {
  try {
    const memberCheck = await query(
      `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2
       AND role IN ('admin', 'moderator')`,
      [req.params.roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) {
      return res.status(403).json({ error: 'Admins only' });
    }

    const result = await query(
      `SELECT ri.token, ri.max_uses, ri.uses, ri.expires_at, ri.created_at,
              u.display_name as created_by_name
       FROM room_invites ri
       JOIN users u ON u.id = ri.created_by
       WHERE ri.room_id = $1 AND ri.expires_at > NOW()
       ORDER BY ri.created_at DESC`,
      [req.params.roomId]
    );

    res.json({ invites: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});

// ── DELETE /api/invites/:token — Revoke invite ──────────────
router.delete('/:token', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM room_invites ri
       USING room_members rm
       WHERE ri.token = $1
         AND rm.room_id = ri.room_id
         AND rm.user_id = $2
         AND rm.role IN ('admin', 'moderator')`,
      [req.params.token, req.user.userId]
    );

    if (!result.rowCount) {
      return res.status(403).json({ error: 'Not authorised or invite not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

module.exports = router;

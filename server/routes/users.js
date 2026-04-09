// routes/users.js — User profile, preferences & avatar management
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { setUserOffline } = require('../db/redis');

const router = express.Router();

// ── GET /api/users — Fetch all users for selection ─────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, display_name, avatar_url, status 
       FROM users 
       ORDER BY display_name ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('[Users] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});


// ── GET /api/users/:id — Public profile ───────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status,
              u.last_seen, u.created_at,
              COUNT(DISTINCT rm.room_id)::int as room_count,
              COUNT(DISTINCT m.id)::int as message_count
       FROM users u
       LEFT JOIN room_members rm ON rm.user_id = u.id
       LEFT JOIN messages m ON m.sender_id = u.id AND NOT m.deleted
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[Users] GET /:id error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PATCH /api/users/me — Update own profile ──────────────
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { displayName, avatarUrl } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) {
      if (!displayName.trim()) return res.status(400).json({ error: 'Display name cannot be empty' });
      if (displayName.length > 100) return res.status(400).json({ error: 'Display name too long' });
      updates.push(`display_name = $${idx++}`);
      values.push(displayName.trim());
    }

    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${idx++}`);
      values.push(avatarUrl || null);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.user.userId);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING id, username, display_name, avatar_url, status, email`,
      values
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[Users] PATCH /me error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── PATCH /api/users/me/password — Change password ────────
router.patch('/me/password', requireAuth, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    const valid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.userId]);

    res.json({ success: true });
  } catch (err) {
    console.error('[Users] password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── GET /api/users/me/preferences — Get notification prefs ─
router.get('/me/preferences', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `INSERT INTO user_preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING;
       SELECT * FROM user_preferences WHERE user_id = $1`,
      [req.user.userId]
    );
    // The second query
    const prefs = await query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );
    res.json({ preferences: prefs.rows[0] || {} });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// ── PATCH /api/users/me/preferences — Update prefs ────────
router.patch('/me/preferences', requireAuth, async (req, res) => {
  try {
    const { notify_mentions, notify_replies, notify_reactions, theme, message_preview } = req.body;

    await query(
      `INSERT INTO user_preferences (user_id, notify_mentions, notify_replies, notify_reactions, theme, message_preview)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         notify_mentions = COALESCE($2, user_preferences.notify_mentions),
         notify_replies = COALESCE($3, user_preferences.notify_replies),
         notify_reactions = COALESCE($4, user_preferences.notify_reactions),
         theme = COALESCE($5, user_preferences.theme),
         message_preview = COALESCE($6, user_preferences.message_preview),
         updated_at = NOW()`,
      [req.user.userId, notify_mentions, notify_replies, notify_reactions, theme, message_preview]
    );

    const result = await query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );
    res.json({ preferences: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// ── GET /api/users/me/activity — Message activity stats ───
router.get('/me/activity', requireAuth, async (req, res) => {
  try {
    const [byDay, byRoom, recentMessages] = await Promise.all([
      // Messages per day, last 30 days
      query(
        `SELECT DATE(created_at) as day, COUNT(*)::int as count
         FROM messages
         WHERE sender_id = $1
           AND created_at > NOW() - INTERVAL '30 days'
           AND NOT deleted
         GROUP BY day ORDER BY day`,
        [req.user.userId]
      ),
      // Top rooms by message count
      query(
        `SELECT r.name, r.room_type, COUNT(m.id)::int as count
         FROM messages m
         JOIN rooms r ON r.id = m.room_id
         WHERE m.sender_id = $1 AND NOT m.deleted
         GROUP BY r.id, r.name, r.room_type
         ORDER BY count DESC LIMIT 5`,
        [req.user.userId]
      ),
      // Recent messages
      query(
        `SELECT m.id, m.content, m.created_at, r.name as room_name
         FROM messages m
         JOIN rooms r ON r.id = m.room_id
         WHERE m.sender_id = $1 AND NOT m.deleted
         ORDER BY m.created_at DESC LIMIT 10`,
        [req.user.userId]
      ),
    ]);

    res.json({
      messagesByDay: byDay.rows,
      topRooms: byRoom.rows,
      recentMessages: recentMessages.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ── DELETE /api/users/me — Delete own account ─────────────
router.delete('/me', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password confirmation required' });

    const bcrypt = require('bcryptjs');
    const user = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    const valid = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Anonymise messages rather than hard-delete (preserve conversation flow)
    await query(
      `UPDATE messages SET content = '[deleted by user]', deleted = TRUE
       WHERE sender_id = $1`,
      [req.user.userId]
    );

    // Remove from all rooms
    await query('DELETE FROM room_members WHERE user_id = $1', [req.user.userId]);

    // Soft-delete the user record
    await query(
      `UPDATE users SET
         email = $1, username = $2,
         display_name = 'Deleted User',
         password_hash = '',
         status = 'offline'
       WHERE id = $3`,
      [
        `deleted_${req.user.userId}@nexchat.invalid`,
        `deleted_${req.user.userId}`,
        req.user.userId,
      ]
    );

    await setUserOffline(req.user.userId);

    res.json({ success: true });
  } catch (err) {
    console.error('[Users] DELETE /me error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;

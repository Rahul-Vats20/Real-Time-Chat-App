// routes/admin.js — Admin dashboard & moderation API
// All endpoints require the requesting user to have admin role in any room,
// or be in the ADMIN_USERS env var list.

const express = require('express');
const { query, withTransaction } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { setUserOffline, getOnlineUsers } = require('../db/redis');

const router = express.Router();

// ── Admin gate middleware ──────────────────────────────────
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);

async function requireAdmin(req, res, next) {
  try {
    // Check env-list first (bootstrap admins)
    if (ADMIN_USERS.includes(req.user.username)) return next();

    // Check if user is admin in any room
    const result = await query(
      `SELECT 1 FROM room_members WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user.userId]
    );
    if (!result.rows.length) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Admin check failed' });
  }
}

// Apply to all admin routes
router.use(requireAuth, requireAdmin);

// ── GET /api/admin/overview ────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const [users, rooms, messages, recentSignups, messageVolume, topUsers] = await Promise.all([
      query('SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status=\'online\')::int as online FROM users'),
      query(`SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE room_type='group')::int as groups,
              COUNT(*) FILTER (WHERE room_type='direct')::int as dms FROM rooms`),
      query(`SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 hour')::int as last_hour,
              COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours')::int as last_day FROM messages WHERE NOT deleted`),
      query(`SELECT id, username, display_name, email, created_at, status
             FROM users ORDER BY created_at DESC LIMIT 10`),
      query(`SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*)::int as count
             FROM messages WHERE created_at > NOW()-INTERVAL '24 hours' AND NOT deleted
             GROUP BY hour ORDER BY hour`),
      query(`SELECT u.id, u.username, u.display_name, u.status,
                    COUNT(m.id)::int as message_count
             FROM users u
             LEFT JOIN messages m ON m.sender_id = u.id AND NOT m.deleted
               AND m.created_at > NOW()-INTERVAL '7 days'
             GROUP BY u.id ORDER BY message_count DESC LIMIT 10`),
    ]);

    const onlineIds = await getOnlineUsers();

    res.json({
      users: { ...users.rows[0], onlineNow: onlineIds.length },
      rooms: rooms.rows[0],
      messages: messages.rows[0],
      recentSignups: recentSignups.rows,
      messageVolume: messageVolume.rows,
      topUsers: topUsers.rows,
    });
  } catch (err) {
    console.error('[Admin] overview error:', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ── GET /api/admin/users — Paginated user list ─────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [`%${search}%`, parseInt(limit), offset];
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `AND u.status = $${params.length}`;
    }

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.email, u.status,
              u.created_at, u.last_seen,
              COUNT(DISTINCT rm.room_id)::int as room_count,
              COUNT(DISTINCT m.id)::int as message_count
       FROM users u
       LEFT JOIN room_members rm ON rm.user_id = u.id
       LEFT JOIN messages m ON m.sender_id = u.id AND NOT m.deleted
       WHERE (u.username ILIKE $1 OR u.display_name ILIKE $1 OR u.email ILIKE $1)
         ${statusFilter}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM users WHERE username ILIKE $1 OR display_name ILIKE $1`,
      [`%${search}%`]
    );

    res.json({
      users: result.rows,
      total: countResult.rows[0].total,
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── POST /api/admin/users/:id/ban — Ban a user ─────────────
router.post('/users/:id/ban', async (req, res) => {
  try {
    const { reason = 'No reason given', durationHours = 24 } = req.body;
    const targetId = req.params.id;

    // Can't ban other admins
    const targetCheck = await query(
      `SELECT 1 FROM room_members WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [targetId]
    );
    if (targetCheck.rows.length) {
      return res.status(403).json({ error: 'Cannot ban an admin user' });
    }

    const bannedUntil = new Date(Date.now() + durationHours * 3600 * 1000);

    await query(
      `UPDATE users SET status = 'offline' WHERE id = $1`,
      [targetId]
    );

    // Log the ban
    await query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user.banned', 'user', $2, $3)`,
      [req.user.userId, targetId, JSON.stringify({ reason, bannedUntil, durationHours })]
    );

    await setUserOffline(targetId);

    res.json({ success: true, bannedUntil });
  } catch (err) {
    console.error('[Admin] ban error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// ── DELETE /api/admin/messages/:id — Hard-delete a message ─
router.delete('/messages/:id', async (req, res) => {
  try {
    const result = await query(
      `UPDATE messages SET deleted = TRUE, content = '[removed by admin]'
       WHERE id = $1
       RETURNING id, room_id`,
      [req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });

    await query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'message.removed', 'message', $2, $3)`,
      [req.user.userId, req.params.id, JSON.stringify({ roomId: result.rows[0].room_id })]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove message' });
  }
});

// ── GET /api/admin/rooms — All rooms with stats ────────────
router.get('/rooms', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.id, r.name, r.description, r.room_type, r.is_private,
              r.created_at,
              COUNT(DISTINCT rm.user_id)::int as member_count,
              COUNT(DISTINCT m.id)::int as message_count,
              MAX(m.created_at) as last_activity
       FROM rooms r
       LEFT JOIN room_members rm ON rm.room_id = r.id
       LEFT JOIN messages m ON m.room_id = r.id AND NOT m.deleted
       GROUP BY r.id
       ORDER BY last_activity DESC NULLS LAST`
    );
    res.json({ rooms: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// ── DELETE /api/admin/rooms/:id — Archive/delete a room ────
router.delete('/rooms/:id', async (req, res) => {
  try {
    await withTransaction(async (client) => {
      // Soft-delete all messages
      await client.query(
        'UPDATE messages SET deleted = TRUE WHERE room_id = $1',
        [req.params.id]
      );

      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id)
         VALUES ($1, 'room.deleted', 'room', $2)`,
        [req.user.userId, req.params.id]
      );

      // Note: keep room record for audit trail, just clear members
      await client.query('DELETE FROM room_members WHERE room_id = $1', [req.params.id]);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// ── GET /api/admin/audit — Audit log ──────────────────────
router.get('/audit', async (req, res) => {
  try {
    const { limit = 50, action = '' } = req.query;
    let actionFilter = '';
    const params = [Math.min(parseInt(limit), 200)];
    if (action) {
      params.push(`%${action}%`);
      actionFilter = `WHERE al.action ILIKE $${params.length}`;
    }

    const result = await query(
      `SELECT al.id, al.action, al.entity_type, al.entity_id,
              al.metadata, al.ip_address, al.created_at,
              json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name) as actor
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ${actionFilter}
       ORDER BY al.created_at DESC
       LIMIT $1`,
      params
    );

    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ── GET /api/admin/stats/retention — Retention stats ──────
router.get('/stats/retention', async (req, res) => {
  try {
    const result = await query(`
      WITH cohorts AS (
        SELECT
          DATE_TRUNC('week', u.created_at) as cohort_week,
          u.id as user_id
        FROM users u
      ),
      activity AS (
        SELECT DISTINCT
          m.sender_id as user_id,
          DATE_TRUNC('week', m.created_at) as active_week
        FROM messages m WHERE NOT m.deleted
      )
      SELECT
        TO_CHAR(c.cohort_week, 'YYYY-MM-DD') as cohort,
        COUNT(DISTINCT c.user_id)::int as cohort_size,
        COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_week = c.cohort_week)::int as week_0,
        COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_week = c.cohort_week + INTERVAL '1 week')::int as week_1,
        COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_week = c.cohort_week + INTERVAL '2 weeks')::int as week_2,
        COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_week = c.cohort_week + INTERVAL '4 weeks')::int as week_4
      FROM cohorts c
      LEFT JOIN activity a ON a.user_id = c.user_id
      GROUP BY c.cohort_week
      ORDER BY c.cohort_week DESC
      LIMIT 12
    `);

    res.json({ retention: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch retention data' });
  }
});

module.exports = router;

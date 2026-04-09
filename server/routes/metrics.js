// routes/metrics.js — Server metrics & monitoring endpoint
// Tracks: active connections, message rates, room activity, system stats
const express = require('express');
const os = require('os');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Rolling window counters ───────────────────────────────
const counters = {
  messagesTotal: 0,
  connectionsTotal: 0,
  disconnectionsTotal: 0,
  errorsTotal: 0,
  // Per-minute buckets (last 60 minutes)
  messagesByMinute: new Array(60).fill(0),
  connectionsByMinute: new Array(60).fill(0),
};

let currentMinute = new Date().getMinutes();

function tick() {
  const m = new Date().getMinutes();
  if (m !== currentMinute) {
    currentMinute = m;
    counters.messagesByMinute[m] = 0;
    counters.connectionsByMinute[m] = 0;
  }
}

// Exported so socket handlers can call these
const record = {
  message: () => {
    tick();
    counters.messagesTotal++;
    counters.messagesByMinute[currentMinute]++;
  },
  connect: () => {
    tick();
    counters.connectionsTotal++;
    counters.connectionsByMinute[currentMinute]++;
  },
  disconnect: () => {
    counters.disconnectionsTotal++;
  },
  error: () => {
    counters.errorsTotal++;
  },
};

// ── GET /api/metrics — Full server stats (admin only) ─────
router.get('/', requireAuth, async (req, res) => {
  try {
    // Verify user is admin in at least one room
    const adminCheck = await query(
      `SELECT 1 FROM room_members WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user.userId]
    );
    if (!adminCheck.rows.length) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    // DB stats
    const [
      userCount,
      roomCount,
      messageCount,
      onlineCount,
      activeRooms,
    ] = await Promise.all([
      query('SELECT COUNT(*)::int as n FROM users'),
      query('SELECT COUNT(*)::int as n FROM rooms'),
      query('SELECT COUNT(*)::int as n FROM messages WHERE NOT deleted'),
      query("SELECT COUNT(*)::int as n FROM users WHERE status = 'online'"),
      query(`
        SELECT r.id, r.name, COUNT(m.id)::int as msg_count
        FROM rooms r
        LEFT JOIN messages m ON m.room_id = r.id
          AND m.created_at > NOW() - INTERVAL '1 hour'
          AND NOT m.deleted
        GROUP BY r.id, r.name
        ORDER BY msg_count DESC
        LIMIT 5
      `),
    ]);

    // System
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = process.memoryUsage();

    // Rate: msgs last 5 mins
    const last5Min = counters.messagesByMinute
      .slice(0, 5)
      .reduce((a, b) => a + b, 0);

    res.json({
      server: {
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
        environment: process.env.NODE_ENV || 'development',
      },
      system: {
        platform: os.platform(),
        cpuCount: cpus.length,
        loadAvg: loadAvg.map(l => l.toFixed(2)),
        memory: {
          totalMB: Math.round(totalMem / 1024 / 1024),
          freeMB: Math.round(freeMem / 1024 / 1024),
          usedPercent: (((totalMem - freeMem) / totalMem) * 100).toFixed(1),
          heapUsedMB: Math.round(usedMem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(usedMem.heapTotal / 1024 / 1024),
          rssMB: Math.round(usedMem.rss / 1024 / 1024),
        },
      },
      database: {
        users: userCount.rows[0].n,
        rooms: roomCount.rows[0].n,
        messages: messageCount.rows[0].n,
        onlineUsers: onlineCount.rows[0].n,
        mostActiveRoomsLastHour: activeRooms.rows,
      },
      traffic: {
        messagesTotal: counters.messagesTotal,
        connectionsTotal: counters.connectionsTotal,
        disconnectionsTotal: counters.disconnectionsTotal,
        errorsTotal: counters.errorsTotal,
        messagesLast5Min: last5Min,
        messagesPerMinute: counters.messagesByMinute.slice(0, 10),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Metrics] error:', err);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// ── GET /api/metrics/health — Lightweight liveness probe ──
router.get('/health', async (req, res) => {
  try {
    // Quick DB ping
    await query('SELECT 1');
    res.json({
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message,
    });
  }
});

module.exports = router;
module.exports.record = record;

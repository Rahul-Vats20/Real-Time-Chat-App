// routes/export.js — Message export: JSON and CSV download
// Members can export their room's message history.
// Large exports are streamed to avoid memory spikes.

const express = require('express');
const { pool, query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/export/:roomId?format=json|csv&since=ISO&until=ISO
router.get('/:roomId', requireAuth, async (req, res) => {
  const { roomId } = req.params;
  const { format = 'json', since, until, includeDeleted = 'false' } = req.query;

  // Verify membership
  const memberCheck = await query(
    'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, req.user.userId]
  ).catch(() => ({ rows: [] }));

  if (!memberCheck.rows.length) {
    return res.status(403).json({ error: 'Not a member of this room' });
  }

  const room = await query('SELECT name FROM rooms WHERE id = $1', [roomId]);
  if (!room.rows.length) return res.status(404).json({ error: 'Room not found' });

  const roomName = room.rows[0].name.replace(/[^a-z0-9_-]/gi, '_');
  const timestamp = new Date().toISOString().slice(0, 10);

  // Build query
  const params = [roomId];
  let conditions = 'WHERE m.room_id = $1';

  if (includeDeleted !== 'true') {
    conditions += ' AND NOT m.deleted';
  }
  if (since) {
    params.push(new Date(since));
    conditions += ` AND m.created_at >= $${params.length}`;
  }
  if (until) {
    params.push(new Date(until));
    conditions += ` AND m.created_at <= $${params.length}`;
  }

  const sql = `
    SELECT
      m.id,
      m.content,
      m.message_type,
      m.edited,
      m.deleted,
      m.reply_to,
      m.created_at,
      u.username as sender_username,
      u.display_name as sender_display_name,
      COALESCE((
        SELECT json_agg(json_build_object('emoji', emoji, 'count', cnt))
        FROM (SELECT emoji, COUNT(*)::int as cnt FROM message_reactions
              WHERE message_id = m.id GROUP BY emoji) r
      ), '[]') as reactions
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    ${conditions}
    ORDER BY m.created_at ASC
  `;

  if (format === 'csv') {
    // Stream CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${roomName}_${timestamp}.csv"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    // BOM for Excel UTF-8 compatibility
    res.write('\uFEFF');
    res.write('id,created_at,sender_username,sender_display_name,message_type,edited,deleted,content,reply_to\n');

    const client = await pool.connect();
    try {
      const cursor = client.query(new (require('pg').Cursor)(sql, params));
      const BATCH = 200;

      const readBatch = () => new Promise((resolve, reject) => {
        cursor.read(BATCH, (err, rows) => err ? reject(err) : resolve(rows));
      });

      while (true) {
        const rows = await readBatch();
        if (!rows.length) break;

        const csvRows = rows.map(r => [
          r.id,
          r.created_at.toISOString(),
          csvEscape(r.sender_username),
          csvEscape(r.sender_display_name),
          r.message_type,
          r.edited,
          r.deleted,
          csvEscape(r.content),
          r.reply_to || '',
        ].join(','));

        res.write(csvRows.join('\n') + '\n');
      }

      cursor.close(() => {});
    } finally {
      client.release();
    }

    res.end();

  } else {
    // Stream JSON (newline-delimited for large exports)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${roomName}_${timestamp}.json"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    const client = await pool.connect();
    try {
      const cursor = client.query(new (require('pg').Cursor)(sql, params));
      const BATCH = 200;
      let first = true;

      // Write metadata header
      const meta = {
        exported_at: new Date().toISOString(),
        exported_by: req.user.userId,
        room_id: roomId,
        room_name: room.rows[0].name,
        filters: { since, until, includeDeleted },
      };
      res.write('{"meta":' + JSON.stringify(meta) + ',"messages":[');

      const readBatch = () => new Promise((resolve, reject) => {
        cursor.read(BATCH, (err, rows) => err ? reject(err) : resolve(rows));
      });

      while (true) {
        const rows = await readBatch();
        if (!rows.length) break;

        for (const row of rows) {
          if (!first) res.write(',');
          res.write(JSON.stringify(row));
          first = false;
        }
      }

      cursor.close(() => {});
    } finally {
      client.release();
    }

    res.write(']}');
    res.end();
  }
});

function csvEscape(str) {
  if (str == null) return '';
  const s = String(str);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = router;

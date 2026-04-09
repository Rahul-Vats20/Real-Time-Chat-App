// services/pgNotify.js
// Bridges PostgreSQL LISTEN/NOTIFY into Socket.io.
// When schema_v4.sql triggers fire (on message INSERT),
// this service picks them up and can fan-out without going through Redis.
//
// Useful for:
//   - Direct DB inserts (admin tools, scheduled messages, imports)
//   - Auditing — catch changes that bypass the API
//   - Cross-service message delivery

const { Pool } = require('pg');

// Dedicated connection for LISTEN (cannot share pool connection)
let notifyClient = null;

async function startPgNotify(io) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'chatdb',
    user: process.env.POSTGRES_USER || 'chatuser',
    password: process.env.POSTGRES_PASSWORD || 'chatpassword',
  });

  notifyClient = await pool.connect();
  console.log('✅ PgNotify: LISTEN connection established');

  // ── Channels to listen on ─────────────────────────────
  await notifyClient.query('LISTEN new_message');
  await notifyClient.query('LISTEN message_updated');
  await notifyClient.query('LISTEN user_status');

  // ── Handle incoming notifications ─────────────────────
  notifyClient.on('notification', async (msg) => {
    try {
      const payload = JSON.parse(msg.payload);

      switch (msg.channel) {
        case 'new_message':
          await handleNewMessage(io, payload);
          break;
        case 'message_updated':
          await handleMessageUpdated(io, payload);
          break;
        case 'user_status':
          await handleUserStatus(io, payload);
          break;
        default:
          console.log('[PgNotify] Unknown channel:', msg.channel);
      }
    } catch (err) {
      console.error('[PgNotify] notification error:', err.message);
    }
  });

  // ── Reconnect on connection drop ──────────────────────
  notifyClient.on('error', async (err) => {
    console.error('[PgNotify] Connection error:', err.message);
    await reconnect(pool, io);
  });

  return notifyClient;
}

async function reconnect(pool, io, attempt = 1) {
  const delay = Math.min(attempt * 2000, 30_000);
  console.log(`[PgNotify] Reconnecting in ${delay}ms (attempt ${attempt})...`);
  await sleep(delay);

  try {
    notifyClient = await pool.connect();
    await notifyClient.query('LISTEN new_message');
    await notifyClient.query('LISTEN message_updated');
    await notifyClient.query('LISTEN user_status');
    console.log('✅ PgNotify: reconnected');
  } catch (err) {
    await reconnect(pool, io, attempt + 1);
  }
}

// ── Handlers ──────────────────────────────────────────────

async function handleNewMessage(io, { id, room_id, sender_id }) {
  // Fetch full message with sender info
  const { Pool } = require('pg');
  const queryPool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'chatdb',
    user: process.env.POSTGRES_USER || 'chatuser',
    password: process.env.POSTGRES_PASSWORD || 'chatpassword',
  });

  try {
    const result = await queryPool.query(
      `SELECT m.id, m.content, m.message_type, m.room_id, m.created_at,
              json_build_object(
                'id', u.id, 'username', u.username,
                'display_name', u.display_name, 'avatar_url', u.avatar_url
              ) as sender
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [id]
    );

    if (result.rows.length) {
      // Only emit if the message isn't already being broadcast by Socket.io
      // (i.e., it came from outside the API — scheduled, admin insert, etc.)
      const socketRooms = io.sockets.adapter.rooms;
      const roomKey = `room:${room_id}`;
      if (socketRooms.has(roomKey)) {
        io.to(roomKey).emit('new_message', {
          message: { ...result.rows[0], read_by: [] },
          source: 'pg_notify', // frontend can distinguish if needed
        });
        console.log(`[PgNotify] Delivered message ${id} to room ${room_id}`);
      }
    }
  } finally {
    queryPool.end().catch(() => {});
  }
}

async function handleMessageUpdated(io, { id, room_id, content, edited }) {
  io.to(`room:${room_id}`).emit('message_edited', {
    message: { id, room_id, content, edited, source: 'pg_notify' },
  });
}

async function handleUserStatus(io, { user_id, status }) {
  io.emit('user_status_change', {
    userId: user_id,
    status,
    lastSeen: new Date().toISOString(),
    source: 'pg_notify',
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopPgNotify() {
  if (notifyClient) {
    notifyClient.release();
    notifyClient = null;
  }
}

module.exports = { startPgNotify, stopPgNotify };

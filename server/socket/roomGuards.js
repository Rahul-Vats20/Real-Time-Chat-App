// socket/roomGuards.js
// Guards applied before message send: slow-mode, read-only, word filter.
// Imported by handlers.js and called within send_message.

const { query } = require('../db/postgres');

// ── Slow mode check ───────────────────────────────────────
// Returns { allowed: true } or { allowed: false, waitSeconds }
async function checkSlowMode(roomId, userId) {
  try {
    const result = await query(
      `SELECT rs.slow_mode_seconds,
              (SELECT MAX(m.created_at)
               FROM messages m
               WHERE m.room_id = $1 AND m.sender_id = $2
               ORDER BY m.created_at DESC LIMIT 1) as last_message_at
       FROM room_settings rs
       WHERE rs.room_id = $1`,
      [roomId, userId]
    );

    if (!result.rows.length) return { allowed: true }; // no settings = no restriction

    const { slow_mode_seconds, last_message_at } = result.rows[0];
    if (!slow_mode_seconds || slow_mode_seconds === 0) return { allowed: true };
    if (!last_message_at) return { allowed: true };

    const elapsedMs = Date.now() - new Date(last_message_at).getTime();
    const requiredMs = slow_mode_seconds * 1000;

    if (elapsedMs < requiredMs) {
      const waitSeconds = Math.ceil((requiredMs - elapsedMs) / 1000);
      return { allowed: false, waitSeconds, slowMode: slow_mode_seconds };
    }

    return { allowed: true };
  } catch (err) {
    console.error('[RoomGuards] checkSlowMode error:', err.message);
    return { allowed: true }; // fail open
  }
}

// ── Read-only check ───────────────────────────────────────
async function checkReadOnly(roomId, userId) {
  try {
    const result = await query(
      `SELECT rs.read_only,
              rm.role
       FROM room_settings rs
       JOIN room_members rm ON rm.room_id = rs.room_id AND rm.user_id = $2
       WHERE rs.room_id = $1`,
      [roomId, userId]
    );

    if (!result.rows.length) return { allowed: true };

    const { read_only, role } = result.rows[0];
    if (!read_only) return { allowed: true };

    // Admins/mods can still write in read-only rooms
    if (['admin', 'moderator'].includes(role)) return { allowed: true };

    return { allowed: false, reason: 'This room is read-only' };
  } catch (err) {
    console.error('[RoomGuards] checkReadOnly error:', err.message);
    return { allowed: true };
  }
}

// ── Content length check ──────────────────────────────────
const MAX_MESSAGE_LENGTH = 4000;

function checkContentLength(content) {
  if (content.length > MAX_MESSAGE_LENGTH) {
    return {
      allowed: false,
      reason: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
    };
  }
  return { allowed: true };
}

// ── Profanity / word filter (configurable) ────────────────
// Add words to BLOCKED_WORDS env var as comma-separated list
const BLOCKED_WORDS = (process.env.BLOCKED_WORDS || '').toLowerCase().split(',').filter(Boolean);

function checkWordFilter(content) {
  if (!BLOCKED_WORDS.length) return { allowed: true };

  const lower = content.toLowerCase();
  const blocked = BLOCKED_WORDS.find(w => lower.includes(w));
  if (blocked) {
    return { allowed: false, reason: 'Message contains blocked content' };
  }
  return { allowed: true };
}

// ── Run all guards ────────────────────────────────────────
async function runGuards(roomId, userId, content) {
  // Sync guards first (fast)
  const lenCheck = checkContentLength(content);
  if (!lenCheck.allowed) return lenCheck;

  const wordCheck = checkWordFilter(content);
  if (!wordCheck.allowed) return wordCheck;

  // Async guards (DB queries)
  const [slowMode, readOnly] = await Promise.all([
    checkSlowMode(roomId, userId),
    checkReadOnly(roomId, userId),
  ]);

  if (!readOnly.allowed) return readOnly;
  if (!slowMode.allowed) return slowMode;

  return { allowed: true };
}

module.exports = { runGuards, checkSlowMode, checkReadOnly, checkContentLength };

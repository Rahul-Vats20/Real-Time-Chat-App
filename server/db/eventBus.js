// db/eventBus.js — Redis Streams-based durable event bus
//
// Unlike pub/sub (fire-and-forget), Redis Streams persist events and
// support consumer groups — missed events are redelivered on reconnect.
// Use this for: audit logs, webhooks, analytics, cross-service events.

const { redisClient } = require('./redis');

const STREAM_KEY = 'nexchat:events';
const CONSUMER_GROUP = 'nexchat-workers';
const MAX_STREAM_LENGTH = 10_000; // trim stream to last 10k events
const BLOCK_TIMEOUT = 2000; // ms to block waiting for new events

// ── Event types ────────────────────────────────────────────
const EventType = {
  MESSAGE_SENT:    'message.sent',
  MESSAGE_EDITED:  'message.edited',
  MESSAGE_DELETED: 'message.deleted',
  USER_JOINED:     'user.joined',
  USER_LEFT:       'user.left',
  USER_STATUS:     'user.status',
  ROOM_CREATED:    'room.created',
  MEMBER_ADDED:    'room.member.added',
  MEMBER_REMOVED:  'room.member.removed',
  REACTION_ADDED:  'reaction.added',
  REACTION_REMOVED:'reaction.removed',
};

// ── Publish an event to the stream ────────────────────────
async function publishEvent(type, payload) {
  try {
    const fields = {
      type,
      payload: JSON.stringify(payload),
      timestamp: Date.now().toString(),
      source: process.env.WORKER_ID || 'main',
    };

    const id = await redisClient.xAdd(
      STREAM_KEY,
      '*', // auto-generate ID
      fields,
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: MAX_STREAM_LENGTH } }
    );

    return id;
  } catch (err) {
    // Non-fatal — log but don't crash the request
    console.error('[EventBus] publishEvent error:', err.message);
    return null;
  }
}

// ── Ensure consumer group exists ──────────────────────────
async function ensureConsumerGroup() {
  try {
    await redisClient.xGroupCreate(STREAM_KEY, CONSUMER_GROUP, '0', { MKSTREAM: true });
    console.log(`✅ EventBus: consumer group "${CONSUMER_GROUP}" ready`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      // Group already exists — fine
    } else {
      console.error('[EventBus] ensureConsumerGroup error:', err.message);
    }
  }
}

// ── Subscribe to events (consumer group, at-least-once) ───
async function subscribeEvents(consumerId, handlers) {
  await ensureConsumerGroup();

  const processMessages = async () => {
    try {
      // Read new messages
      const results = await redisClient.xReadGroup(
        CONSUMER_GROUP,
        consumerId,
        [{ key: STREAM_KEY, id: '>' }], // '>' = only new, undelivered messages
        { COUNT: 50, BLOCK: BLOCK_TIMEOUT }
      );

      if (results) {
        for (const { messages } of results) {
          for (const { id, message } of messages) {
            try {
              const event = {
                id,
                type: message.type,
                payload: JSON.parse(message.payload),
                timestamp: parseInt(message.timestamp),
                source: message.source,
              };

              const handler = handlers[event.type] || handlers['*'];
              if (handler) await handler(event);

              // Acknowledge processed message
              await redisClient.xAck(STREAM_KEY, CONSUMER_GROUP, id);
            } catch (handlerErr) {
              console.error(`[EventBus] Handler error for ${message.type}:`, handlerErr.message);
              // Don't ACK — will be redelivered
            }
          }
        }
      }

      // Check for pending (unACKed) messages from crashed consumers
      await processPending(consumerId, handlers);

    } catch (err) {
      if (!err.message.includes('Connection')) {
        console.error('[EventBus] processMessages error:', err.message);
      }
    }
  };

  // Process pending messages (from crashed consumers)
  const processPending = async (consumerId, handlers) => {
    try {
      const pending = await redisClient.xAutoClaim(
        STREAM_KEY,
        CONSUMER_GROUP,
        consumerId,
        60_000, // claim messages idle > 60s
        '0-0',
        { COUNT: 10 }
      );

      for (const { id, message } of (pending?.messages || [])) {
        try {
          const event = {
            id,
            type: message.type,
            payload: JSON.parse(message.payload),
            timestamp: parseInt(message.timestamp),
            source: message.source,
          };
          const handler = handlers[event.type] || handlers['*'];
          if (handler) await handler(event);
          await redisClient.xAck(STREAM_KEY, CONSUMER_GROUP, id);
        } catch {}
      }
    } catch {}
  };

  // Continuous polling loop
  let running = true;
  const loop = async () => {
    while (running) {
      await processMessages();
    }
  };

  loop().catch(err => console.error('[EventBus] Loop crashed:', err.message));

  return () => { running = false; }; // return cleanup function
}

// ── Read raw stream history (for audit logs) ──────────────
async function readStreamHistory(count = 100, startId = '-') {
  try {
    const results = await redisClient.xRange(STREAM_KEY, startId, '+', { COUNT: count });
    return results.map(({ id, message }) => ({
      id,
      type: message.type,
      payload: JSON.parse(message.payload),
      timestamp: parseInt(message.timestamp),
      source: message.source,
    }));
  } catch (err) {
    console.error('[EventBus] readStreamHistory error:', err.message);
    return [];
  }
}

// ── Stream info / monitoring ───────────────────────────────
async function getStreamInfo() {
  try {
    const info = await redisClient.xInfoStream(STREAM_KEY);
    const groups = await redisClient.xInfoGroups(STREAM_KEY);
    return { length: info.length, groups };
  } catch {
    return { length: 0, groups: [] };
  }
}

// ── Example: Audit log handler ────────────────────────────
// Wire this up in index.js to capture all events:
//
//   const { subscribeEvents, EventType } = require('./db/eventBus');
//   subscribeEvents(`worker-${process.pid}`, {
//     [EventType.MESSAGE_SENT]: async (event) => {
//       await query(
//         'INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)',
//         [event.payload.senderId, 'message.sent', 'message', event.payload.messageId, event.payload]
//       );
//     },
//     '*': async (event) => {
//       console.log('[Audit]', event.type, event.payload);
//     },
//   });

module.exports = {
  publishEvent,
  subscribeEvents,
  readStreamHistory,
  getStreamInfo,
  ensureConsumerGroup,
  EventType,
};

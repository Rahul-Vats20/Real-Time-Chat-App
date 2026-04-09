// db/redis.js - Redis client setup for caching, pub/sub, and session management
const { createClient } = require('redis');

// Main Redis client (commands)
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('❌ Redis: Max reconnect attempts reached');
        return new Error('Max reconnect attempts');
      }
      return Math.min(retries * 100, 3000);
    },
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

// Subscriber client (for pub/sub - needs separate connection)
const redisSub = redisClient.duplicate();

// Publisher client
const redisPub = redisClient.duplicate();

const connectRedis = async () => {
  try {
    await redisClient.connect();
    await redisSub.connect();
    await redisPub.connect();
    console.log('✅ Redis clients connected');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.log('⚠️  Continuing without Redis (caching disabled)');
  }
};

// =====================================================
// PRESENCE MANAGEMENT
// Store online users with TTL for auto-expiry
// =====================================================
const PRESENCE_TTL = 60; // seconds

const setUserOnline = async (userId, socketId) => {
  try {
    await redisClient.hSet(`presence:${userId}`, {
      socketId,
      status: 'online',
      lastSeen: Date.now().toString(),
    });
    await redisClient.expire(`presence:${userId}`, PRESENCE_TTL);
    await redisClient.sAdd('online_users', userId);
  } catch (err) {
    console.error('[Redis] setUserOnline error:', err.message);
  }
};

const setUserOffline = async (userId) => {
  try {
    await redisClient.del(`presence:${userId}`);
    await redisClient.sRem('online_users', userId);
  } catch (err) {
    console.error('[Redis] setUserOffline error:', err.message);
  }
};

const getUserPresence = async (userId) => {
  try {
    return await redisClient.hGetAll(`presence:${userId}`);
  } catch (err) {
    console.error('[Redis] getUserPresence error:', err.message);
    return null;
  }
};

const getOnlineUsers = async () => {
  try {
    return await redisClient.sMembers('online_users');
  } catch (err) {
    console.error('[Redis] getOnlineUsers error:', err.message);
    return [];
  }
};

// =====================================================
// TYPING INDICATORS
// Store who is typing in each room with short TTL
// =====================================================
const TYPING_TTL = 5; // seconds

const setTyping = async (roomId, userId, username) => {
  try {
    await redisClient.hSet(`typing:${roomId}`, userId, username);
    await redisClient.expire(`typing:${roomId}`, TYPING_TTL);
  } catch (err) {
    console.error('[Redis] setTyping error:', err.message);
  }
};

const clearTyping = async (roomId, userId) => {
  try {
    await redisClient.hDel(`typing:${roomId}`, userId);
  } catch (err) {
    console.error('[Redis] clearTyping error:', err.message);
  }
};

const getTypingUsers = async (roomId) => {
  try {
    return await redisClient.hGetAll(`typing:${roomId}`);
  } catch (err) {
    console.error('[Redis] getTypingUsers error:', err.message);
    return {};
  }
};

// =====================================================
// MESSAGE CACHING
// Cache recent messages per room
// =====================================================
const CACHE_SIZE = 50;
const CACHE_TTL = 3600; // 1 hour

const cacheMessage = async (roomId, message) => {
  try {
    const key = `messages:${roomId}`;
    await redisClient.lPush(key, JSON.stringify(message));
    await redisClient.lTrim(key, 0, CACHE_SIZE - 1);
    await redisClient.expire(key, CACHE_TTL);
  } catch (err) {
    console.error('[Redis] cacheMessage error:', err.message);
  }
};

const getCachedMessages = async (roomId, count = 20) => {
  try {
    const messages = await redisClient.lRange(`messages:${roomId}`, 0, count - 1);
    return messages.map(m => JSON.parse(m)).reverse();
  } catch (err) {
    console.error('[Redis] getCachedMessages error:', err.message);
    return null;
  }
};

const invalidateRoomCache = async (roomId) => {
  try {
    await redisClient.del(`messages:${roomId}`);
  } catch (err) {
    console.error('[Redis] invalidateRoomCache error:', err.message);
  }
};

// =====================================================
// OFFLINE MESSAGE QUEUE (Redis Layer)
// Fast queue before persisting to PostgreSQL
// =====================================================
const queueOfflineMessage = async (userId, messageData) => {
  try {
    const key = `offline:${userId}`;
    await redisClient.rPush(key, JSON.stringify(messageData));
    await redisClient.expire(key, 86400 * 7); // 7 days
  } catch (err) {
    console.error('[Redis] queueOfflineMessage error:', err.message);
  }
};

const getOfflineMessages = async (userId) => {
  try {
    const key = `offline:${userId}`;
    const messages = await redisClient.lRange(key, 0, -1);
    await redisClient.del(key);
    return messages.map(m => JSON.parse(m));
  } catch (err) {
    console.error('[Redis] getOfflineMessages error:', err.message);
    return [];
  }
};

// =====================================================
// PUB/SUB (for horizontal scaling across nodes)
// =====================================================
const publish = async (channel, data) => {
  try {
    await redisPub.publish(channel, JSON.stringify(data));
  } catch (err) {
    console.error('[Redis] publish error:', err.message);
  }
};

const subscribe = async (channel, callback) => {
  try {
    await redisSub.subscribe(channel, (message) => {
      try {
        callback(JSON.parse(message));
      } catch (err) {
        console.error('[Redis] subscribe callback error:', err.message);
      }
    });
  } catch (err) {
    console.error('[Redis] subscribe error:', err.message);
  }
};

module.exports = {
  redisClient,
  redisSub,
  redisPub,
  connectRedis,
  // Presence
  setUserOnline,
  setUserOffline,
  getUserPresence,
  getOnlineUsers,
  // Typing
  setTyping,
  clearTyping,
  getTypingUsers,
  // Cache
  cacheMessage,
  getCachedMessages,
  invalidateRoomCache,
  // Offline queue
  queueOfflineMessage,
  getOfflineMessages,
  // Pub/Sub
  publish,
  subscribe,
};

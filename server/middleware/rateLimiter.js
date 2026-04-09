// middleware/rateLimiter.js
// In-memory rate limiter (swap redisClient for distributed deployments)

const limits = new Map(); // key -> { count, resetAt }

/**
 * Create a rate limiter function
 * @param {number} maxRequests - Max requests allowed
 * @param {number} windowMs - Time window in ms
 * @param {string} label - Label for error messages
 */
function createLimiter(maxRequests, windowMs, label = 'requests') {
  return function check(key) {
    const now = Date.now();
    const entry = limits.get(key);

    if (!entry || now > entry.resetAt) {
      limits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter, label };
    }

    entry.count++;
    return { allowed: true, remaining: maxRequests - entry.count };
  };
}

// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of limits.entries()) {
    if (now > entry.resetAt) limits.delete(key);
  }
}, 60_000);

// Different limiters for different actions
const limiters = {
  message:  createLimiter(30, 10_000, 'messages'),   // 30 messages per 10s
  auth:     createLimiter(10, 60_000, 'auth attempts'), // 10 logins per min
  roomCreate: createLimiter(5, 60_000, 'room creation'), // 5 rooms per min
  typing:   createLimiter(20, 5_000, 'typing events'),  // 20 typing per 5s
};

// Express middleware factory
function httpRateLimit(limiterName) {
  return (req, res, next) => {
    const limiter = limiters[limiterName];
    if (!limiter) return next(); // unknown limiter name — skip

    const key = `${limiterName}:${req.ip}`;
    const result = limiter(key); // limiters[x] IS the check function

    if (!result.allowed) {
      return res.status(429).json({
        error: `Too many ${result.label}. Retry after ${result.retryAfter}s.`,
        retryAfter: result.retryAfter,
      });
    }
    next();
  };
}

// Socket.io rate check
function socketRateLimit(limiterName, userId) {
  const limiter = limiters[limiterName];
  if (!limiter) return { allowed: true };
  const key = `${limiterName}:${userId}`;
  return limiter(key); // same fix — call directly
}

module.exports = { httpRateLimit, socketRateLimit, limiters };

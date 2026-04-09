// middleware/auth.js - JWT authentication middleware
const jwt = require('jsonwebtoken');
const { query } = require('../db/postgres');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Generate access token (short-lived)
const generateToken = (userId, username) => {
  return jwt.sign(
    { userId, username },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};

// Verify token and return payload
const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
};

// HTTP middleware
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    // Attach user info to request
    req.user = { userId: payload.userId, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Socket.io middleware
const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.slice(7);

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const payload = verifyToken(token);

    // Fetch fresh user data from DB
    const result = await query(
      'SELECT id, username, display_name, avatar_url, status FROM users WHERE id = $1',
      [payload.userId]
    );

    if (!result.rows.length) {
      return next(new Error('User not found'));
    }

    socket.user = result.rows[0];
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
};

module.exports = { generateToken, verifyToken, requireAuth, socketAuth };

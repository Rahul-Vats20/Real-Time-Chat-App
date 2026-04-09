// routes/auth.js - Authentication endpoints
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/postgres');
const { generateToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;

    if (!username || !displayName || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check uniqueness
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO users (username, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, email, avatar_url, status, created_at`,
      [username.toLowerCase(), displayName, email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user.id, user.username);

    // Auto-join General room
    await query(
      `INSERT INTO room_members (room_id, user_id, role)
       SELECT id, $1, 'member' FROM rooms WHERE name = 'General'
       ON CONFLICT DO NOTHING`,
      [user.id]
    );

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await query(
      `SELECT id, username, display_name, email, password_hash, avatar_url, status
       FROM users WHERE username = $1 OR email = $1`,
      [username.toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id, user.username);
    const { password_hash, ...safeUser } = user;

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /auth/me - Get current user profile
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, username, display_name, email, avatar_url, status, last_seen, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[Auth] Me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;

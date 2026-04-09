// index.js - Main server entry point
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const helmet = require('helmet');
const compression = require('compression');
const { connectRedis } = require('./db/redis');
const { socketAuth } = require('./middleware/auth');
const { registerSocketHandlers } = require('./socket/handlers');
const authRoutes = require('./routes/auth');
const roomsRoutes = require('./routes/rooms');
const searchRoutes = require('./routes/search');
const reactionsRoutes = require('./routes/reactions');
const notificationsRoutes = require('./routes/notifications');
const { httpRateLimit } = require('./middleware/rateLimiter');
const metricsRoutes = require('./routes/metrics');
const threadsRoutes = require('./routes/threads');
const invitesRoutes = require('./routes/invites');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const draftsRoutes = require('./routes/drafts');
const { startScheduler } = require('./routes/drafts');
const { record } = require('./routes/metrics');
const webhooksRoutes = require('./services/webhooks');
const pushRoutes = require('./services/pushNotifications');
const exportRoutes = require('./routes/export');
const roomSettingsRoutes = require('./routes/roomSettings');
const { startPgNotify, stopPgNotify } = require('./services/pgNotify');
const e2eRoutes = require('./services/e2eEncryption');

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

// =====================================================
// EXPRESS APP
// =====================================================
const app = express();

app.use(helmet({
  contentSecurityPolicy: false, // disabled for dev; configure properly in prod
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '../client/public')));

// API Routes
app.use('/api/auth', httpRateLimit('auth'), authRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/reactions', reactionsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/threads', threadsRoutes);
app.use('/api/invites', invitesRoutes);

// Invite join page — redirect to frontend with token
app.get('/join/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/drafts', draftsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/room-settings', roomSettingsRoutes);
app.use('/api/e2e', e2eRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '1.2.0',
  });
});

// Catch-all: serve frontend for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// =====================================================
// HTTP SERVER + SOCKET.IO
// =====================================================
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// Make io accessible to routes (e.g., roomSettings broadcasts)
app.set('io', io);

// Auth middleware for all sockets
io.use(socketAuth);

// Register handlers for each connection
io.on('connection', (socket) => {
  record.connect();
  registerSocketHandlers(io, socket, record);
});

// =====================================================
// STARTUP
// =====================================================
const start = async () => {
  // Connect to Redis (non-fatal - system works without it)
  await connectRedis();

  httpServer.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════╗');
    console.log('║      Real-Time Chat System            ║');
    console.log(`║      Server running on port ${PORT}      ║`);
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
    console.log(`📡 WebSocket:  ws://localhost:${PORT}`);
    console.log(`🌐 REST API:   http://localhost:${PORT}/api`);
    console.log(`💚 Health:     http://localhost:${PORT}/health`);
    console.log('');

    // Start message scheduler
    startScheduler(io);

    // Start PostgreSQL LISTEN/NOTIFY bridge
    startPgNotify(io).catch(err =>
      console.warn('⚠️  PgNotify unavailable (non-fatal):', err.message)
    );
  });
};

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n⚠️  Received ${signal}, shutting down gracefully...`);
  stopPgNotify();
  httpServer.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

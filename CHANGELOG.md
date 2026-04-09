# CHANGELOG

All notable changes to NexChat are documented here.

---

## [1.2.0] — Current

### Added
- **E2E Encryption** key exchange infrastructure (`services/e2eEncryption.js`)
  - X25519 public key registry (server stores only public keys)
  - Batch key fetch for room members
  - Per-room E2E readiness status
  - Client-side implementation guide in comments (SubtleCrypto + AES-GCM)
- **Room Guards** (`socket/roomGuards.js`)
  - Slow-mode enforcement (configurable per room, 0–3600s)
  - Read-only room enforcement (admins/mods bypass)
  - Message length limit (4000 chars)
  - Configurable word filter (`BLOCKED_WORDS` env var)
- **Performance Profiler** (`scripts/profile.js`)
  - Benchmarks all major API endpoints
  - Reports mean/p50/p90/p99 latencies
  - Concurrent burst tests (10 simultaneous)
  - Grade assessment with optimization hints
- **Redis Cluster Config** (`redis/redis-cluster.conf`)
  - 6-node cluster (3 primary + 3 replica)
  - Cluster mode with gossip ports
  - AOF persistence + LRU eviction
- **Schema v7** — E2E tables, 8 new performance indexes, weekly maintenance procedure, `db_health_check()` function
- `update_room_settings` socket event — real-time settings broadcast

### Changed
- Socket `send_message` now runs all room guards before persisting
- `scripts/migrate.js` tracks schema_v7
- Server version bumped to 1.2.0

---

## [1.1.0]

### Added
- **Admin Dashboard** (`client/public/admin.html`)
  - JWT auth gate with auto-login
  - Dashboard: stat cards, 24h message volume chart (Chart.js), top users, recent signups
  - Analytics: weekly cohort retention heatmap, active rooms, system stats
  - Users: paginated table, search, status filter, ban modal
  - Rooms: all rooms with stats, soft-delete
  - Audit Log: filterable, 50 entries
  - Metrics: live system stats, auto-refresh every 30s
- **Web Push Notifications** (`services/pushNotifications.js`)
  - VAPID key management, lazy-load web-push package
  - Browser subscription storage (per-device)
  - Pushes only to offline users (online get socket events)
  - Respects user notification preferences
  - Auto-cleanup expired subscriptions (HTTP 410)
- **Message Export** (`routes/export.js`)
  - Streaming PostgreSQL cursor (200-row batches)
  - JSON (with metadata header) and CSV (BOM for Excel)
  - Date range filters, include-deleted option
  - Correct Content-Disposition filename
- **Room Settings** (`routes/roomSettings.js`)
  - Topic, emoji icon, slow-mode, read-only toggle
  - Changes broadcast via `room_settings_updated` socket event
  - `io` attached to Express app for route access
- **Makefile** — 25 targets: dev, test, db ops, redis ops, prod, clean, keys
- **Migration Runner** (`scripts/migrate.js`)
  - Tracks applied versions in `_migrations` table
  - `--status`, `--dry-run`, `--reset` flags
  - Per-migration transaction with rollback
- **Schema v6** — push_subscriptions, export_log, `search_messages()` function, `db_stats` view, new indexes

### Changed
- `package.json` version → 1.1.0, added migrate/profile scripts
- `Makefile` references `schema_v6.sql`

---

## [1.0.3]

### Added
- **nginx config** (`nginx/nexchat.conf`) — TLS 1.2/1.3, WebSocket proxy, rate limiting zones, static caching
- **Production docker-compose** (`docker-compose.prod.yml`) — 4 server replicas, rolling deploy, certbot, pgbackup
- **Production Dockerfile** (`server/Dockerfile.prod`) — multi-stage, non-root user, HEALTHCHECK
- **GitHub Actions CI/CD** (`.github/workflows/ci.yml`) — lint, test with real DB/Redis, multi-arch Docker build, SSH deploy
- **Webhook System** (`services/webhooks.js`) — HMAC-SHA256 signing, 3-attempt retry with backoff, delivery logging
- **PostgreSQL LISTEN/NOTIFY bridge** (`services/pgNotify.js`) — catches DB inserts outside API, fans out to Socket.io
- **Service Worker** (`client/public/sw.js`) — offline fallback, cache-first for static, Background Sync for offline messages, Web Push handler
- **PWA manifest** (`client/public/manifest.json`) — all icon sizes, share target, shortcuts
- **Offline page** (`client/public/offline.html`) — auto-reconnect detection
- **Mobile responsive layout** — sidebar drawer, swipe-to-open, safe-area padding
- **Webhook manager UI** — create/test/delete webhooks per room
- **PWA install prompt** — beforeinstallprompt capture, sidebar install button
- **Schema v5** — webhook_deliveries, slow-mode function, new indexes, hourly activity view

---

## [1.0.2]

### Added
- **Cluster manager** (`server/cluster.js`) — one worker per CPU, auto-restart with exponential backoff
- **Redis Streams event bus** (`db/eventBus.js`) — durable events, consumer groups, pending-message claiming
- **User profiles & settings** (`routes/users.js`) — update profile, change password, preferences, activity stats, account delete
- **Admin routes** (`routes/admin.js`) — overview, user list with pagination, ban, message removal, retention cohort analysis
- **Message drafts & scheduler** (`routes/drafts.js`) — per-room drafts, scheduled messages with 30s tick
- **WebSocket integration tests** (`tests/websocket.test.js`) — 20 tests across connect, rooms, messaging, read receipts, typing, editing, presence, reactions
- **Schema v4** — message_drafts, scheduled_messages, webhooks, room_settings, pg_trgm indexes, LISTEN/NOTIFY trigger

### Changed
- `registerSocketHandlers()` accepts `record` for metrics
- Metrics counters wired to connect/disconnect/message events

---

## [1.0.1]

### Added
- **Rate limiter** (`middleware/rateLimiter.js`) — per-user/action, HTTP and socket
- **Full-text search** (`routes/search.js`) — messages (tsvector), users, rooms
- **Emoji reactions** (`routes/reactions.js`) — toggle, aggregated counts
- **Mention notifications** (`routes/notifications.js`) — parse @username, persist, socket delivery
- **Message threading** (`routes/threads.js`) — reply chains, thread list, pinned messages
- **Invite links** (`routes/invites.js`) — token, expiry, max-uses, accept flow
- **Message drafts REST** (`routes/drafts.js`) — per-room draft upsert
- **File uploads** (`routes/uploads.js`) — multer, 10MB, image/PDF/text
- **Metrics endpoint** (`routes/metrics.js`) — rolling counters, DB stats, system info
- **Schema additions** — reactions, notifications, FTS index, pinned_messages, user_preferences, audit_log
- **Schema v3** — room_invites, composite indexes, room_summary view, get_unread_count() function
- **REST API test suite** (`tests/chat.test.js`) — 30 tests, zero deps

### Frontend
- Search bar with live results
- Emoji reaction picker, pills with counts
- Notification bell + panel
- Reply preview bar
- @mention autocomplete (keyboard navigable)
- Right-click room context menu
- Metrics panel modal
- Invite URL handling

---

## [1.0.0] — Initial Release

### Core Features
- WebSocket messaging via Socket.io (with polling fallback)
- Message persistence in PostgreSQL
- Read receipts (per-message, per-user, real-time broadcast)
- Typing indicators (Redis TTL 5s, auto-expire)
- Group chats with admin/moderator/member roles
- Offline message delivery (Redis queue + PostgreSQL backup)
- Presence system (online/away/busy/offline)
- Message editing and soft-deletion
- JWT authentication (HTTP + WebSocket handshake)
- Multi-core cluster via Node.js cluster module
- Redis caching (last 50 messages per room)
- PostgreSQL connection pool with transaction helper

### Infrastructure
- Docker Compose development setup
- PostgreSQL 16 schema with seed data (4 demo users, 3 rooms)
- Redis 7 for presence, typing, cache, offline queue, pub/sub
- Express.js with helmet, compression, CORS

### Frontend
- Industrial dark theme (JetBrains Mono + DM Sans)
- Auth overlay (login/register)
- Room sidebar with unread badges
- Real-time message feed
- Member list with presence indicators
- Status picker

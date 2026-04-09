# ⚡ NexChat — Production-Grade Real-Time Chat

A complete, scalable real-time messaging system: Node.js + Socket.io + Redis + PostgreSQL.

## Quick Start
```bash
docker compose up -d
# Open http://localhost:3001  |  Login: alice / password
```

## Architecture
```
Clients ──► Load Balancer ──► Worker 1..N (Express + Socket.io)
                                    │
                              Redis 7 (pub/sub, streams, presence, cache)
                                    │
                           PostgreSQL 16 (all persistence)
```

## Feature Matrix
| Feature | Notes |
|---------|-------|
| WebSocket messaging | Socket.io, polling fallback |
| Message persistence | Full history, pagination |
| Read receipts | Per-message, per-user, real-time |
| Typing indicators | Redis TTL auto-expire |
| Group chats | admin/moderator/member roles |
| Offline delivery | Redis queue + PostgreSQL backup |
| Presence | online/away/busy/offline |
| Emoji reactions | 15 emoji, toggle, broadcast |
| @mentions | Parse, notify, socket delivery |
| Full-text search | PostgreSQL tsvector + GIN |
| Thread replies | Chains, thread list per room |
| Pinned messages | Admin/mod gated |
| Invite links | Token, expiry, max-uses |
| DM rooms | 1:1 direct messages |
| Message drafts | Auto-save per room |
| Scheduled messages | Future delivery, 30-day max |
| File uploads | Images/PDF/text, 10MB |
| Rate limiting | Per-user, per-action |
| Multi-core cluster | Auto-restart on crash |
| Redis event bus | Streams + consumer groups |
| Admin dashboard | User mgmt, moderation |
| Metrics endpoint | DB stats, traffic, system |
| Audit log | All admin actions |
| Cohort retention | Weekly, last 12 cohorts |
| Production hardening | helmet, compression, CORS |

## Project Structure
```
server/
  index.js              Entry point (Express + Socket.io)
  cluster.js            Multi-core cluster manager
  schema*.sql           4 schema files, run in order
  db/
    postgres.js         Connection pool + transactions
    redis.js            Presence, typing, cache, offline queue
    eventBus.js         Redis Streams durable event bus
  middleware/
    auth.js             JWT (HTTP + WebSocket)
    rateLimiter.js      Per-user/action rate limiting
  routes/
    auth.js             Register, login, /me
    rooms.js            CRUD, messages, read receipts
    users.js            Profiles, preferences, activity, delete
    search.js           FTS messages/users/rooms
    reactions.js        Emoji toggle
    notifications.js    Mentions, reads
    threads.js          Reply chains + pins
    invites.js          Room invite links
    drafts.js           Drafts + scheduled messages
    uploads.js          File upload
    metrics.js          Server stats
    admin.js            Dashboard + moderation + retention
  socket/handlers.js    All Socket.io event handlers
client/public/index.html  Frontend SPA (~3000 lines)
tests/
  chat.test.js          REST API suite (30 tests, zero deps)
  websocket.test.js     WebSocket integration suite (20 tests)
  load-test.js          Concurrent user load tester
```

## Running Tests
```bash
cd server && npm install

npm test            # REST API tests
npm run test:ws     # WebSocket integration tests
npm run test:all    # Both suites

# Load test
npm run test:load
node ../tests/load-test.js --users 100 --duration 30 --ramp 5
```

## Scaling
```bash
node index.js          # single core
node cluster.js        # all CPU cores
WORKERS=4 node cluster.js
```

## Environment
```env
PORT=3001
JWT_SECRET=<strong-random>
POSTGRES_HOST=localhost
POSTGRES_DB=chatdb
POSTGRES_USER=chatuser
POSTGRES_PASSWORD=<pw>
REDIS_HOST=localhost
WORKERS=4
ADMIN_USERS=alice,bob
ALLOWED_ORIGINS=https://yourapp.com
```

## Socket Events

**Client → Server:** `join_room`, `leave_room`, `send_message`, `edit_message`,
`delete_message`, `mark_read`, `typing_start`, `typing_stop`, `update_status`,
`toggle_reaction`, `add_member`, `remove_member`

**Server → Client:** `room_history`, `new_message`, `message_edited`, `message_deleted`,
`message_read`, `user_typing`, `user_stopped_typing`, `reaction_updated`, `online_users`,
`user_status_change`, `offline_messages`, `notification`, `added_to_room`, `member_added`,
`member_removed`, `error`

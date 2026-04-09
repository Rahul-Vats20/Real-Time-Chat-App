# NexChat Deployment Guide

Complete guide for deploying NexChat from development to production.

---

## Table of Contents

1. [Local Development](#local-development)
2. [Docker Development](#docker-development)
3. [Production: Single Server](#production-single-server)
4. [Production: Multi-Server Cluster](#production-multi-server-cluster)
5. [Environment Variables](#environment-variables)
6. [Database Operations](#database-operations)
7. [Monitoring & Observability](#monitoring--observability)
8. [Troubleshooting](#troubleshooting)

---

## Local Development

### Prerequisites
- Node.js 20+
- PostgreSQL 16
- Redis 7

```bash
# 1. Install dependencies
make install

# 2. Start databases
make db-up redis-up

# 3. Apply schema
make db-migrate

# 4. Copy and edit environment
cp server/.env.example server/.env
# Edit server/.env with your local settings

# 5. Start development server (hot-reload)
make dev

# 6. Open http://localhost:3001
# Login with demo accounts: alice / password
```

---

## Docker Development

Fastest way to get running:

```bash
# Start everything (PostgreSQL + Redis + Server)
docker compose up -d

# View logs
docker compose logs -f server

# Stop
docker compose down
```

The development compose applies all schema files automatically on first boot.

---

## Production: Single Server

### 1. Server preparation

```bash
# Ubuntu 22.04 LTS
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-plugin make git nginx certbot python3-certbot-nginx

# Add your user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Clone and configure

```bash
git clone https://github.com/yourorg/nexchat.git /opt/nexchat
cd /opt/nexchat

# Create production .env
cat > server/.env << EOF
PORT=3001
NODE_ENV=production
JWT_SECRET=$(openssl rand -base64 48)
POSTGRES_HOST=localhost
POSTGRES_DB=chatdb
POSTGRES_USER=chatuser
POSTGRES_PASSWORD=$(openssl rand -base64 32)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=$(openssl rand -base64 32)
ALLOWED_ORIGINS=https://yourdomain.com
ADMIN_USERS=alice
WORKERS=4
EOF
```

### 3. SSL certificate

```bash
# Stop any service using port 80 first
sudo certbot certonly --standalone -d yourdomain.com --email admin@yourdomain.com --agree-tos --no-eff-email

# Certificate location:
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem
```

### 4. Configure nginx

```bash
# Edit domain in config
sed -i 's/yourdomain.com/actualdomain.com/g' nginx/nexchat.conf

# Link config
sudo ln -s /opt/nexchat/nginx/nexchat.conf /etc/nginx/sites-enabled/nexchat
sudo ln -s /opt/nexchat/nginx/proxy_params /etc/nginx/proxy_params
sudo nginx -t && sudo systemctl restart nginx
```

### 5. Start production stack

```bash
make prod
# or: docker compose -f docker-compose.prod.yml up -d

# Check status
make prod-status

# View logs
make prod-logs
```

### 6. Run migrations

```bash
cd server
NODE_ENV=production node ../scripts/migrate.js
```

### 7. Verify

```bash
curl https://yourdomain.com/health
# {"status":"ok","uptime":...}
```

---

## Production: Multi-Server Cluster

For high availability across multiple servers:

### Architecture

```
Internet → Load Balancer (HAProxy/nginx)
              ├── Server 1 (Node cluster, 4 workers)
              ├── Server 2 (Node cluster, 4 workers)
              └── Server 3 (Node cluster, 4 workers)
                     │
              ┌──────┴──────┐
         PostgreSQL       Redis Cluster
         (primary +        (3 primary +
          2 replicas)       3 replicas)
```

### Load balancer requirement

Socket.io requires sticky sessions (same client → same server) OR the Redis adapter.

**Option A: Sticky sessions (simpler)**
```nginx
upstream nexchat {
    ip_hash;  # sticky by client IP
    server 10.0.0.1:3001;
    server 10.0.0.2:3001;
    server 10.0.0.3:3001;
}
```

**Option B: Redis adapter (recommended for true HA)**
```bash
# Install socket.io-redis adapter
cd server && npm install @socket.io/redis-adapter

# Add to index.js (after io = new Server(...)):
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const pubClient = createClient({ url: 'redis://...' });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
```

### Database replication

```bash
# On PostgreSQL primary: enable replication
echo "host replication replicator 10.0.0.0/24 md5" >> pg_hba.conf

# On replica:
pg_basebackup -h primary-ip -U replicator -D /var/lib/postgresql/data -P -Xs -R
```

### Redis cluster setup

```bash
# Start 6 Redis instances (3 primary + 3 replica)
for port in 7001 7002 7003 7004 7005 7006; do
    sed "s/7001/$port/g" redis/redis-cluster.conf > /tmp/redis-$port.conf
    redis-server /tmp/redis-$port.conf --daemonize yes
done

# Create cluster
redis-cli --cluster create \
    127.0.0.1:7001 127.0.0.1:7002 127.0.0.1:7003 \
    127.0.0.1:7004 127.0.0.1:7005 127.0.0.1:7006 \
    --cluster-replicas 1 -a your-password
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3001 | HTTP server port |
| `NODE_ENV` | No | development | Environment mode |
| `JWT_SECRET` | **Yes** | — | JWT signing secret (min 32 chars) |
| `POSTGRES_HOST` | No | localhost | PostgreSQL host |
| `POSTGRES_PORT` | No | 5432 | PostgreSQL port |
| `POSTGRES_DB` | No | chatdb | Database name |
| `POSTGRES_USER` | No | chatuser | Database user |
| `POSTGRES_PASSWORD` | **Yes** | — | Database password |
| `REDIS_HOST` | No | localhost | Redis host |
| `REDIS_PORT` | No | 6379 | Redis port |
| `REDIS_PASSWORD` | No | — | Redis password |
| `ALLOWED_ORIGINS` | No | http://localhost:3000 | CORS origins (comma-separated) |
| `ADMIN_USERS` | No | — | Admin usernames (comma-separated) |
| `WORKERS` | No | CPU count | Cluster worker count |
| `BLOCKED_WORDS` | No | — | Comma-separated blocked words |
| `VAPID_PUBLIC_KEY` | No | — | Web Push public key |
| `VAPID_PRIVATE_KEY` | No | — | Web Push private key |
| `VAPID_EMAIL` | No | admin@nexchat.app | Web Push contact email |

### Generate VAPID keys for Web Push

```bash
cd server && npm install web-push
make keys
# Outputs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
```

---

## Database Operations

### Apply migrations
```bash
# Check status
node scripts/migrate.js --status

# Apply pending
node scripts/migrate.js

# Dry run (see what would be applied)
node scripts/migrate.js --dry-run
```

### Backup
```bash
make db-backup
# Creates: backups/nexchat_YYYYMMDD_HHMMSS.sql.gz
```

### Restore
```bash
gunzip < backups/nexchat_20241201_030000.sql.gz | \
  PGPASSWORD=password psql -h localhost -U chatuser chatdb
```

### Refresh analytics
```bash
PGPASSWORD=password psql -h localhost -U chatuser chatdb \
  -c "PERFORM refresh_analytics();"
```

### Run maintenance
```bash
PGPASSWORD=password psql -h localhost -U chatuser chatdb \
  -c "CALL run_maintenance();"
```

### Health check
```bash
PGPASSWORD=password psql -h localhost -U chatuser chatdb \
  -c "SELECT * FROM db_health_check();"
```

---

## Monitoring & Observability

### Built-in endpoints

```bash
# Liveness probe (no auth)
curl http://localhost:3001/api/metrics/health

# Full metrics (auth required)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/metrics
```

### Admin dashboard

Navigate to `http://yourdomain.com/admin.html` and login with an admin account.

### Performance profiling

```bash
# Profile against running server
npm run profile
# or: node scripts/profile.js --url http://localhost:3001

# Verbose output (shows . per request)
npm run profile:verbose
```

### Load testing

```bash
# Default: 20 users, 15 seconds
npm run test:load

# Custom
node tests/load-test.js --users 100 --duration 60 --ramp 10
```

### PostgreSQL query analysis

```sql
-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Check index usage
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;

-- Table sizes
SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass))
FROM pg_tables WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
```

### Redis monitoring

```bash
# Connect to Redis
make redis-cli

# Key stats
INFO keyspace

# Memory usage
INFO memory

# Slow log
SLOWLOG GET 10

# Monitor live commands (dev only)
MONITOR
```

---

## Troubleshooting

### Server won't start

```bash
# Check for port conflicts
lsof -i :3001

# Check logs
docker compose logs server

# Test DB connection
PGPASSWORD=password psql -h localhost -U chatuser -d chatdb -c "SELECT 1"

# Test Redis connection
redis-cli -h localhost ping
```

### WebSocket connections failing

```bash
# Check nginx WebSocket headers
curl -I -H "Upgrade: websocket" -H "Connection: Upgrade" http://localhost:3001/socket.io/

# Check server transports (should include websocket)
curl http://localhost:3001/socket.io/?EIO=4&transport=polling
```

### Messages not delivering to offline users

```bash
# Check Redis offline queue
redis-cli LLEN offline:<userId>

# Check PostgreSQL queue
psql -c "SELECT COUNT(*) FROM offline_message_queue WHERE NOT delivered;"
```

### High memory usage

```bash
# Check Node.js heap
curl -H "Authorization: Bearer $TOKEN" localhost:3001/api/metrics | jq .system.memory

# Force GC (development only)
node --expose-gc index.js
# then: global.gc() via REPL

# Redis memory
redis-cli INFO memory | grep used_memory_human
```

### Slow search queries

```bash
# Verify FTS index exists
psql -c "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_messages_fulltext';"

# Rebuild if missing
psql -c "CREATE INDEX CONCURRENTLY idx_messages_fulltext ON messages USING GIN(content_tsv);"

# Analyze query plan
psql -c "EXPLAIN ANALYZE SELECT * FROM messages WHERE content_tsv @@ plainto_tsquery('hello');"
```

### SSL certificate renewal

```bash
# Auto-renewal (should be set up by certbot)
sudo certbot renew --dry-run

# Manual renewal
sudo certbot renew
sudo systemctl reload nginx
```

---

## Security Checklist

Before going to production:

- [ ] `JWT_SECRET` is a random 48+ byte string
- [ ] `POSTGRES_PASSWORD` and `REDIS_PASSWORD` are strong
- [ ] `NODE_ENV=production` is set
- [ ] Firewall allows only ports 80 and 443 from internet
- [ ] PostgreSQL and Redis ports (5432, 6379) are NOT exposed publicly
- [ ] Nginx SSL is configured with TLS 1.2/1.3 minimum
- [ ] HSTS header is enabled in nginx
- [ ] File upload directory is outside web root or has content-type enforcement
- [ ] `ADMIN_USERS` is set to trusted accounts only
- [ ] Rate limiting is active (auth: 5r/m, API: 30r/s)
- [ ] Regular backups are configured and tested
- [ ] Monitor logs for unusual activity

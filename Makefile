# Makefile — NexChat developer convenience commands
# Usage: make <target>
# Requires: make, docker, docker compose, node, psql

.PHONY: help dev prod test test-ws test-load install \
        db-up db-down db-reset db-shell db-migrate db-seed \
        redis-up redis-cli logs clean lint

# ── Default: show help ────────────────────────────────────
help:
	@echo ""
	@echo "  ⚡ NexChat Makefile"
	@echo ""
	@echo "  Development"
	@echo "    make install      Install all dependencies"
	@echo "    make dev          Start server in dev mode (nodemon)"
	@echo "    make dev-full     Start postgres + redis + server"
	@echo ""
	@echo "  Testing"
	@echo "    make test         Run REST API test suite"
	@echo "    make test-ws      Run WebSocket integration tests"
	@echo "    make test-load    Run load test (20 users, 15s)"
	@echo "    make test-all     Run all tests"
	@echo ""
	@echo "  Database"
	@echo "    make db-up        Start PostgreSQL container"
	@echo "    make db-migrate   Apply all schema files"
	@echo "    make db-seed      Apply seed data"
	@echo "    make db-reset     Drop and recreate database"
	@echo "    make db-shell     Open psql shell"
	@echo "    make db-backup    Create a backup dump"
	@echo ""
	@echo "  Redis"
	@echo "    make redis-up     Start Redis container"
	@echo "    make redis-cli    Open Redis CLI"
	@echo "    make redis-flush  DANGER: flush all Redis data"
	@echo ""
	@echo "  Production"
	@echo "    make prod         Start full production stack"
	@echo "    make prod-down    Stop production stack"
	@echo "    make prod-logs    Tail production logs"
	@echo "    make prod-scale   Scale server to 4 replicas"
	@echo ""
	@echo "  Utility"
	@echo "    make lint         Check for syntax errors"
	@echo "    make logs         Tail dev server logs"
	@echo "    make clean        Remove node_modules, logs, uploads"
	@echo "    make keys         Generate VAPID keys for push notifs"
	@echo ""

# ── Variables ─────────────────────────────────────────────
DB_HOST     ?= localhost
DB_PORT     ?= 5432
DB_NAME     ?= chatdb
DB_USER     ?= chatuser
DB_PASS     ?= chatpassword
DB_URL      = postgresql://$(DB_USER):$(DB_PASS)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)
REDIS_PORT  ?= 6379
SERVER_PORT ?= 3001
SERVER_DIR  = server
TEST_URL    ?= http://localhost:$(SERVER_PORT)

# ── Install ───────────────────────────────────────────────
install:
	@echo "📦 Installing server dependencies..."
	cd $(SERVER_DIR) && npm install
	@echo "📦 Installing test dependencies..."
	cd $(SERVER_DIR) && npm install --save-dev socket.io-client
	@echo "✅ Done"

# ── Development ───────────────────────────────────────────
dev:
	@echo "🚀 Starting dev server..."
	cd $(SERVER_DIR) && npm run dev

dev-full: db-up redis-up
	@echo "⏳ Waiting for services..."
	@sleep 2
	$(MAKE) db-migrate
	@echo "🚀 Starting dev server..."
	cd $(SERVER_DIR) && npm run dev

# ── Testing ───────────────────────────────────────────────
test:
	@echo "🧪 Running REST API tests..."
	TEST_URL=$(TEST_URL) node tests/chat.test.js

test-ws:
	@echo "🧪 Running WebSocket integration tests..."
	TEST_URL=$(TEST_URL) node tests/websocket.test.js

test-load:
	@echo "⚡ Running load test..."
	node tests/load-test.js --url $(TEST_URL) --users 20 --duration 15

test-load-heavy:
	@echo "💥 Running heavy load test..."
	node tests/load-test.js --url $(TEST_URL) --users 100 --duration 30 --ramp 5

test-all: test test-ws
	@echo "✅ All tests complete"

# ── Database ──────────────────────────────────────────────
db-up:
	@echo "🐘 Starting PostgreSQL..."
	docker run -d --name nexchat-postgres-dev \
		-e POSTGRES_DB=$(DB_NAME) \
		-e POSTGRES_USER=$(DB_USER) \
		-e POSTGRES_PASSWORD=$(DB_PASS) \
		-p $(DB_PORT):5432 \
		postgres:16-alpine \
		2>/dev/null || docker start nexchat-postgres-dev
	@echo "⏳ Waiting for PostgreSQL..."
	@until PGPASSWORD=$(DB_PASS) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) -d $(DB_NAME) -c "SELECT 1" > /dev/null 2>&1; do sleep 1; done
	@echo "✅ PostgreSQL ready"

db-migrate:
	@echo "📋 Applying schema migrations..."
	PGPASSWORD=$(DB_PASS) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) -d $(DB_NAME) \
		-f $(SERVER_DIR)/schema.sql \
		-f $(SERVER_DIR)/schema_additions.sql \
		-f $(SERVER_DIR)/schema_v3.sql \
		-f $(SERVER_DIR)/schema_v4.sql \
		-f $(SERVER_DIR)/schema_v5.sql \
		-f $(SERVER_DIR)/schema_v6.sql
	@echo "✅ Migrations applied"

db-reset:
	@echo "⚠️  Resetting database (all data will be lost)..."
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	PGPASSWORD=$(DB_PASS) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) \
		-c "DROP DATABASE IF EXISTS $(DB_NAME);"
	PGPASSWORD=$(DB_PASS) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) \
		-c "CREATE DATABASE $(DB_NAME);"
	$(MAKE) db-migrate
	@echo "✅ Database reset complete"

db-shell:
	PGPASSWORD=$(DB_PASS) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) -d $(DB_NAME)

db-backup:
	@mkdir -p backups
	PGPASSWORD=$(DB_PASS) pg_dump -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) $(DB_NAME) \
		| gzip > backups/nexchat_$(shell date +%Y%m%d_%H%M%S).sql.gz
	@echo "✅ Backup saved to backups/"

db-seed:
	@echo "🌱 Seed data is included in schema.sql (demo users + rooms)"
	@echo "   To re-seed: make db-reset"

# ── Redis ─────────────────────────────────────────────────
redis-up:
	@echo "🔴 Starting Redis..."
	docker run -d --name nexchat-redis-dev \
		-p $(REDIS_PORT):6379 \
		redis:7-alpine \
		2>/dev/null || docker start nexchat-redis-dev
	@echo "✅ Redis ready"

redis-cli:
	docker exec -it nexchat-redis-dev redis-cli

redis-flush:
	@echo "⚠️  Flushing all Redis data..."
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	docker exec nexchat-redis-dev redis-cli FLUSHALL
	@echo "✅ Redis flushed"

# ── Production ────────────────────────────────────────────
prod:
	@echo "🚀 Starting production stack..."
	docker compose -f docker-compose.prod.yml up -d
	@echo "✅ Production stack running"
	@echo "   nginx: http://localhost (port 80/443)"

prod-down:
	docker compose -f docker-compose.prod.yml down

prod-logs:
	docker compose -f docker-compose.prod.yml logs -f --tail=100

prod-scale:
	docker compose -f docker-compose.prod.yml up -d --scale server=4

prod-status:
	docker compose -f docker-compose.prod.yml ps
	@echo ""
	@curl -sf http://localhost/health | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d))"

# ── Dev stack using docker-compose ────────────────────────
stack-up:
	docker compose up -d postgres redis
	@sleep 2
	$(MAKE) db-migrate

stack-down:
	docker compose down

# ── Utility ───────────────────────────────────────────────
lint:
	@echo "🔍 Checking syntax..."
	@find $(SERVER_DIR) -name "*.js" \
		! -path "*/node_modules/*" \
		-exec node --check {} \; \
		-print 2>&1 | grep -E "(Error|✓|\.js)" || true
	@echo "✅ Lint complete"

logs:
	@tail -f /tmp/nexchat-dev.log 2>/dev/null || echo "No log file found. Start server with: make dev 2>&1 | tee /tmp/nexchat-dev.log"

clean:
	@echo "🧹 Cleaning..."
	rm -rf $(SERVER_DIR)/node_modules
	rm -rf client/public/uploads/*
	rm -f /tmp/nexchat-dev.log
	@echo "✅ Clean complete"

keys:
	@echo "🔑 Generating VAPID keys for Web Push..."
	@node -e " \
		try { \
			const wp = require('./server/node_modules/web-push'); \
			const keys = wp.generateVAPIDKeys(); \
			console.log('Add to .env:'); \
			console.log('VAPID_PUBLIC_KEY=' + keys.publicKey); \
			console.log('VAPID_PRIVATE_KEY=' + keys.privateKey); \
			console.log('VAPID_EMAIL=admin@yourdomain.com'); \
		} catch(e) { \
			console.log('Install web-push first: cd server && npm install web-push'); \
		} \
	"

version:
	@echo "NexChat v1.0.0"
	@echo "Node: $$(node --version)"
	@echo "npm:  $$(npm --version)"
	@docker --version 2>/dev/null || echo "Docker: not found"

-- =====================================================
-- Chat System Consolidated Database Schema
-- PostgreSQL
-- =====================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================
-- USERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  status VARCHAR(20) DEFAULT 'offline' CHECK (status IN ('online', 'away', 'busy', 'offline')),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ROOMS (GROUP CHATS + DMs) TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100),
  description TEXT,
  room_type VARCHAR(20) DEFAULT 'group' CHECK (room_type IN ('direct', 'group', 'channel')),
  is_private BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ROOM MEMBERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS room_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- =====================================================
-- MESSAGES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file', 'system')),
  reply_to UUID REFERENCES messages(id) ON DELETE SET NULL,
  edited BOOLEAN DEFAULT FALSE,
  edited_at TIMESTAMPTZ,
  deleted BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MESSAGE READ RECEIPTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS message_reads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

-- =====================================================
-- MESSAGE REACTIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

-- =====================================================
-- NOTIFICATIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL CHECK (type IN ('mention', 'reply', 'reaction', 'room_invite', 'system', 'message')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  read BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MESSAGE PINS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS pinned_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, message_id)
);

-- =====================================================
-- ROOM INVITES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS room_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token VARCHAR(20) UNIQUE NOT NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  max_uses INT DEFAULT 10,
  uses INT DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MESSAGE DRAFTS
-- =====================================================
CREATE TABLE IF NOT EXISTS message_drafts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- =====================================================
-- SCHEDULED MESSAGES
-- =====================================================
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ROOM SETTINGS
-- =====================================================
CREATE TABLE IF NOT EXISTS room_settings (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  topic TEXT,
  icon VARCHAR(10),
  slow_mode_seconds INT DEFAULT 0,
  read_only BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- WEBHOOKS
-- =====================================================
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  url TEXT NOT NULL,
  secret VARCHAR(64),
  events TEXT[] DEFAULT ARRAY['message.sent'],
  enabled BOOLEAN DEFAULT TRUE,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- WEBHOOK DELIVERIES LOG
-- =====================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
  event VARCHAR(50) NOT NULL,
  payload JSONB,
  response_status INT,
  response_body TEXT,
  duration_ms INT,
  success BOOLEAN DEFAULT FALSE,
  error TEXT,
  attempt INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- PUSH NOTIFICATION SUBSCRIPTIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  keys JSONB NOT NULL DEFAULT '{}',
  device_name VARCHAR(100) DEFAULT 'Browser',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- USER PREFERENCES
-- =====================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_mentions BOOLEAN DEFAULT TRUE,
  notify_replies BOOLEAN DEFAULT TRUE,
  notify_reactions BOOLEAN DEFAULT FALSE,
  theme VARCHAR(20) DEFAULT 'dark',
  message_preview BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- USER PUBLIC KEYS (for E2E encryption)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_public_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  key_id VARCHAR(100) UNIQUE NOT NULL,
  algorithm VARCHAR(20) DEFAULT 'X25519',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ROOM E2E STATUS
-- =====================================================
CREATE TABLE IF NOT EXISTS room_e2e_status (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  e2e_enabled BOOLEAN DEFAULT FALSE,
  all_keys_registered BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MESSAGE ENCRYPTION METADATA
-- =====================================================
CREATE TABLE IF NOT EXISTS message_e2e_metadata (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  ephemeral_public_key TEXT,
  algorithm VARCHAR(30) DEFAULT 'X25519+AES-GCM-256',
  key_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- AUDIT LOGS
-- =====================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(30),
  entity_id UUID,
  metadata JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS export_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  format VARCHAR(10) NOT NULL DEFAULT 'json',
  row_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- OFFLINE MESSAGE QUEUE
-- =====================================================
CREATE TABLE IF NOT EXISTS offline_message_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  delivered BOOLEAN DEFAULT FALSE,
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(room_id, sender_id, created_at) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC) WHERE NOT deleted;

CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_room_members_room_id ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_composite ON room_members(room_id, user_id, role);

CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id);

CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON message_reactions(message_id, emoji);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, created_at DESC) WHERE NOT read;
CREATE INDEX IF NOT EXISTS idx_notifications_badge ON notifications(user_id, read) WHERE NOT read;

CREATE INDEX IF NOT EXISTS idx_offline_queue_user_id ON offline_message_queue(user_id, delivered);
CREATE INDEX IF NOT EXISTS idx_offline_queue_delivery ON offline_message_queue(user_id, delivered, queued_at) WHERE NOT delivered;

CREATE INDEX IF NOT EXISTS idx_room_invites_token ON room_invites(token);
CREATE INDEX IF NOT EXISTS idx_room_invites_room_id ON room_invites(room_id);
CREATE INDEX IF NOT EXISTS idx_room_invites_expires_at ON room_invites(expires_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(scheduled_at, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(scheduled_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_success ON webhook_deliveries(success, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id) WHERE endpoint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drafts_user ON message_drafts(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_keys_user_active ON user_public_keys(user_id, active);
CREATE INDEX IF NOT EXISTS idx_public_keys_key_id ON user_public_keys(key_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_webhooks_room_events ON webhooks(room_id, enabled);

-- Full-text search indexes
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_messages_fulltext ON messages USING GIN(content_tsv);

CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING GIN(username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING GIN(display_name gin_trgm_ops);

-- =====================================================
-- FUNCTIONS & TRIGGERS
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rooms_updated_at BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_drafts_updated_at BEFORE UPDATE ON message_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('new_message', json_build_object(
    'id', NEW.id,
    'room_id', NEW.room_id,
    'sender_id', NEW.sender_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_notify ON messages;
CREATE TRIGGER messages_notify
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_new_message();

CREATE OR REPLACE FUNCTION get_unread_count(p_room_id UUID, p_user_id UUID)
RETURNS INT AS $$
  SELECT COUNT(*)::int
  FROM messages m
  JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = p_user_id
  WHERE m.room_id = p_room_id
    AND m.sender_id != p_user_id
    AND m.created_at > rm.last_read_at
    AND NOT m.deleted;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION check_slow_mode(p_room_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  slow_seconds INT;
  last_msg_time TIMESTAMPTZ;
BEGIN
  SELECT COALESCE(slow_mode_seconds, 0)
    INTO slow_seconds
    FROM room_settings WHERE room_id = p_room_id;

  IF slow_seconds = 0 THEN RETURN TRUE; END IF;

  SELECT MAX(created_at)
    INTO last_msg_time
    FROM messages
    WHERE room_id = p_room_id AND sender_id = p_user_id;

  IF last_msg_time IS NULL THEN RETURN TRUE; END IF;

  RETURN (NOW() - last_msg_time) >= (slow_seconds || ' seconds')::INTERVAL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION search_messages(
  p_user_id UUID,
  p_query TEXT,
  p_room_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID, content TEXT, created_at TIMESTAMPTZ,
  room_id UUID, room_name VARCHAR,
  sender_id UUID, sender_name VARCHAR,
  rank REAL
) AS $$
  SELECT
    m.id, m.content, m.created_at,
    r.id as room_id, r.name as room_name,
    u.id as sender_id, u.display_name as sender_name,
    ts_rank(m.content_tsv, plainto_tsquery('english', p_query)) as rank
  FROM messages m
  JOIN rooms r ON r.id = m.room_id
  JOIN users u ON u.id = m.sender_id
  JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = p_user_id
  WHERE NOT m.deleted
    AND m.content_tsv @@ plainto_tsquery('english', p_query)
    AND (p_room_id IS NULL OR m.room_id = p_room_id)
  ORDER BY rank DESC, m.created_at DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION cleanup_webhook_deliveries()
RETURNS void AS $$
  DELETE FROM webhook_deliveries
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY webhook_id ORDER BY created_at DESC) as rn
      FROM webhook_deliveries
    ) ranked WHERE rn > 1000
  );
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION refresh_analytics()
RETURNS void AS $$
  -- REFRESH MATERIALIZED VIEW CONCURRENTLY room_analytics;
  -- Note: Requires unique index and initial data. 
  -- Simplified for consolidated schema.
  NULL;
$$ LANGUAGE SQL;

CREATE OR REPLACE PROCEDURE run_maintenance()
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM room_invites WHERE expires_at < NOW();
  PERFORM cleanup_webhook_deliveries();
  DELETE FROM offline_message_queue
    WHERE delivered = TRUE AND delivered_at < NOW() - INTERVAL '7 days';
  DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days';
  -- PERFORM refresh_analytics();
  RAISE NOTICE 'Maintenance complete';
END;
$$;

-- =====================================================
-- VIEWS & MATERIALIZED VIEWS
-- =====================================================
CREATE OR REPLACE VIEW room_summary AS
SELECT
  r.id, r.name, r.description, r.room_type, r.is_private, r.created_at,
  COUNT(DISTINCT rm.user_id)::int as member_count,
  COUNT(DISTINCT m.id)::int as message_count,
  MAX(m.created_at) as last_message_at
FROM rooms r
LEFT JOIN room_members rm ON rm.room_id = r.id
LEFT JOIN messages m ON m.room_id = r.id AND NOT m.deleted
GROUP BY r.id;

CREATE OR REPLACE VIEW user_dms AS
SELECT
  rm1.user_id as viewer_id, r.id as room_id,
  u.id as other_user_id, u.display_name as other_display_name,
  u.username as other_username, u.avatar_url as other_avatar_url,
  u.status as other_status, u.last_seen as other_last_seen
FROM rooms r
JOIN room_members rm1 ON rm1.room_id = r.id
JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id != rm1.user_id
JOIN users u ON u.id = rm2.user_id
WHERE r.room_type = 'direct';

CREATE OR REPLACE VIEW room_hourly_activity AS
SELECT
  room_id, EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC') as hour_utc,
  COUNT(*)::int as message_count
FROM messages
WHERE NOT deleted AND created_at > NOW() - INTERVAL '30 days'
GROUP BY room_id, hour_utc;

CREATE OR REPLACE VIEW db_stats AS
SELECT
  (SELECT COUNT(*)::int FROM users) as total_users,
  (SELECT COUNT(*)::int FROM users WHERE status = 'online') as online_users,
  (SELECT COUNT(*)::int FROM rooms) as total_rooms,
  (SELECT COUNT(*)::int FROM messages WHERE NOT deleted) as total_messages,
  (SELECT pg_size_pretty(pg_database_size(current_database()))) as db_size,
  NOW() as generated_at;

-- =====================================================
-- SEED DATA (Demo Users & Rooms)
-- =====================================================
INSERT INTO users (id, username, display_name, email, password_hash, status) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'alice', 'Alice Johnson', 'alice@demo.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'online'),
  ('a1000000-0000-0000-0000-000000000002', 'bob', 'Bob Smith', 'bob@demo.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'online'),
  ('a1000000-0000-0000-0000-000000000003', 'carol', 'Carol Williams', 'carol@demo.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'away'),
  ('a1000000-0000-0000-0000-000000000004', 'david', 'David Brown', 'david@demo.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'offline')
ON CONFLICT DO NOTHING;

INSERT INTO rooms (id, name, description, room_type, created_by) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'General', 'Welcome to the general chat!', 'group', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', 'Engineering', 'Technical discussions', 'group', 'a1000000-0000-0000-0000-000000000002'),
  ('b1000000-0000-0000-0000-000000000003', 'Random', 'Off-topic conversations', 'group', 'a1000000-0000-0000-0000-000000000003')
ON CONFLICT DO NOTHING;

INSERT INTO room_members (room_id, user_id, role) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'admin'),
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'member'),
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'member'),
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000004', 'member')
ON CONFLICT DO NOTHING;

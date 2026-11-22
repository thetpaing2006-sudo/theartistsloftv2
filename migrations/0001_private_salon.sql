-- Run this against the site's Cloudflare D1 database before deploying these Pages Functions.
-- The migration does not modify site_settings; POST /api/salon/admin action=migrate_legacy
-- performs a one-time, admin-authenticated import and removes old member fields afterwards.
CREATE TABLE IF NOT EXISTS salon_members (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT,
  hash_scheme TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  legacy_pass_hash TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  login_count INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at TEXT,
  device TEXT,
  newsletter_opt_in INTEGER NOT NULL DEFAULT 0,
  newsletter_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS salon_sessions (
  token_hash TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(member_email) REFERENCES salon_members(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS salon_sessions_email_idx ON salon_sessions(member_email);
CREATE INDEX IF NOT EXISTS salon_sessions_expiry_idx ON salon_sessions(expires_at);

CREATE TABLE IF NOT EXISTS salon_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(member_email) REFERENCES salon_members(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS salon_reset_email_idx ON salon_reset_tokens(member_email);
CREATE INDEX IF NOT EXISTS salon_reset_expiry_idx ON salon_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS salon_newsletter_tokens (
  token_hash TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(member_email) REFERENCES salon_members(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS salon_newsletter_email_idx ON salon_newsletter_tokens(member_email);

CREATE TABLE IF NOT EXISTS salon_rate_limits (
  id TEXT PRIMARY KEY,
  limiter_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS salon_rate_lookup_idx ON salon_rate_limits(limiter_hash, action, created_at);

CREATE TABLE IF NOT EXISTS salon_member_logs (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  member_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  device TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY(member_email) REFERENCES salon_members(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS salon_logs_time_idx ON salon_member_logs(timestamp DESC);

CREATE TABLE IF NOT EXISTS salon_campaign_logs (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT,
  subject TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salon_migrations (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

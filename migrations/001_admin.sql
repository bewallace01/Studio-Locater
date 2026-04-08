-- ─────────────────────────────────────────────────────────────────────────────
-- Studio Locater Admin — D1 Schema
-- Apply with: npx wrangler d1 execute studio-locater-admin --file=migrations/001_admin.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- OAuth sessions (also stored in KV, but D1 gives us audit trail)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT PRIMARY KEY,           -- random 32-byte hex
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,           -- unix seconds
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);

-- User signup events (your main site calls POST /api/track/signup)
CREATE TABLE IF NOT EXISTS user_signups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT,                       -- optional, hashed on insert for privacy
  source      TEXT,                       -- e.g. "homepage", "studio_page"
  metadata    TEXT,                       -- JSON blob for extra context
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Blog posts (AI-generated, stored here, served via /blog/:slug)
CREATE TABLE IF NOT EXISTS blog_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  excerpt     TEXT,
  body_html   TEXT NOT NULL,
  topic       TEXT,                       -- the prompt/topic used to generate
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  published_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Blog schedule (recurring auto-generation config)
CREATE TABLE IF NOT EXISTS blog_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_pool  TEXT NOT NULL,              -- JSON array of topic strings to rotate through
  frequency   TEXT NOT NULL DEFAULT 'weekly',  -- daily | weekly | biweekly
  day_of_week INTEGER DEFAULT 1,          -- 0=Sun … 6=Sat (for weekly/biweekly)
  auto_publish INTEGER NOT NULL DEFAULT 0,  -- 0=save as draft, 1=auto-publish
  active      INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signups_created ON user_signups (created_at);
CREATE INDEX IF NOT EXISTS idx_posts_status    ON blog_posts (status, published_at);
CREATE INDEX IF NOT EXISTS idx_posts_slug      ON blog_posts (slug);

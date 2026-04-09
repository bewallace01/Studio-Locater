-- Migration 003: User accounts, sessions, magic links, favorites
-- Run locally:  npx wrangler d1 execute studio-locater-admin --local --file=migrations/003_accounts.sql -y
-- Run remote:   npx wrangler d1 execute studio-locater-admin --remote --file=migrations/003_accounts.sql -y

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE,
  name         TEXT,
  -- 'instant' | 'weekly' | 'both' | 'none'
  email_pref   TEXT    NOT NULL DEFAULT 'instant',
  verified     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Short-lived tokens for email verification / passwordless login (15-minute TTL)
CREATE TABLE IF NOT EXISTS magic_links (
  id         TEXT    PRIMARY KEY,   -- 48-char hex token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Long-lived user session cookies (30-day TTL)
CREATE TABLE IF NOT EXISTS user_sessions (
  id         TEXT    PRIMARY KEY,   -- 64-char hex token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Saved/favorited studios per user
CREATE TABLE IF NOT EXISTS user_favorites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  studio_id    TEXT    NOT NULL,   -- Sanity _id, Google placeId, or composite key
  studio_name  TEXT,
  studio_data  TEXT,               -- JSON snapshot: {name, address, rating, imageUrl, tags}
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, studio_id)
);

CREATE INDEX IF NOT EXISTS idx_magic_links_user     ON magic_links(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user   ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user  ON user_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);

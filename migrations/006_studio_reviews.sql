-- Migration 006: User-submitted studio reviews
-- Run locally:  npx wrangler d1 execute studio-locater-admin --local  --file=migrations/006_studio_reviews.sql -y
-- Run remote:   npx wrangler d1 execute studio-locater-admin --remote --file=migrations/006_studio_reviews.sql -y

CREATE TABLE IF NOT EXISTS studio_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_slug  TEXT    NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email   TEXT    NOT NULL,
  rating       INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- one review per user per studio (upsert on repeat submit)
  UNIQUE(studio_slug, user_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_reviews_slug ON studio_reviews(studio_slug);
CREATE INDEX IF NOT EXISTS idx_studio_reviews_user ON studio_reviews(user_id);

-- Migration 007: Add studio_name to studio_reviews for account dashboard display
-- Run locally:  npx wrangler d1 execute studio-locater-admin --local  --file=migrations/007_studio_reviews_name.sql -y
-- Run remote:   npx wrangler d1 execute studio-locater-admin --remote --file=migrations/007_studio_reviews_name.sql -y

ALTER TABLE studio_reviews ADD COLUMN studio_name TEXT;

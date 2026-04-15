-- Track whether subscriber “new post” emails were already sent for this row (avoids duplicates on republish).
ALTER TABLE blog_posts ADD COLUMN subscriber_notify_sent_at INTEGER;

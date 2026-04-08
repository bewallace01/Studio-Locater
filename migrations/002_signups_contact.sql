-- Store contact email for admin review (hashed `email` column kept for legacy rows).
ALTER TABLE user_signups ADD COLUMN email_address TEXT;

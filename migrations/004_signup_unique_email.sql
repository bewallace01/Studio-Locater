-- One row per contact email in user_signups (analytics / admin counts).
-- Anonymous rows (NULL email_address) are unchanged — multiple allowed.

UPDATE user_signups
SET email_address = lower(trim(email_address))
WHERE email_address IS NOT NULL AND trim(email_address) != '';

DELETE FROM user_signups
WHERE email_address IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM user_signups
    WHERE email_address IS NOT NULL
    GROUP BY email_address
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_signups_email_unique
  ON user_signups(email_address)
  WHERE email_address IS NOT NULL;

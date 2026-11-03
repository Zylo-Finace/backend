-- Unique Zylo ramp usernames (case-insensitive via lowercase storage).
UPDATE "zylo_ramp_users" SET "username" = lower("username") WHERE "username" IS NOT NULL;

-- Drop dupes keeping the earliest row (by id); clear later duplicates.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY lower(username) ORDER BY id ASC) AS rn
  FROM "zylo_ramp_users"
  WHERE "username" IS NOT NULL
)
UPDATE "zylo_ramp_users" u
SET "username" = NULL
FROM ranked r
WHERE u.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "zylo_ramp_users_username_key"
  ON "zylo_ramp_users"("username");

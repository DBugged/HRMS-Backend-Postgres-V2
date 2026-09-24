-- Login emails become case-insensitive: `A@X.test` and `a@x.test` used to be
-- two separate accounts (users_email_key is case-sensitive) and a mixed-case
-- login for a lowercase account failed. The app now trims + lowercases every
-- login email on input (see common/normalize-input.ts); this migration
-- brings existing rows in line and enforces it in the database.
--
-- 1. Refuse to run if two accounts differ only by case/surrounding
--    whitespace. Merging them is a data decision (two real people? one
--    duplicate?) that must be made by a human, not silently here — the
--    exception lists the offending addresses so they can be resolved first.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(emails, E'\n')
    INTO dupes
    FROM (
      SELECT lower(btrim(email)) AS normalized,
             string_agg(email || ' (' || id || ')', ', ' ORDER BY email) AS emails
        FROM "users"
       GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot normalize users.email: accounts differ only by letter case. Resolve these first:' || E'\n' || dupes;
  END IF;
END
$$;

-- 2. Lowercase (and trim) existing login emails.
UPDATE "users"
   SET "email" = lower(btrim("email"))
 WHERE "email" <> lower(btrim("email"));

-- 3. Case-insensitive uniqueness in the database itself, so a concurrent
--    or non-DTO write path can't reintroduce case-only duplicates. The
--    existing users_email_key constraint is kept (Prisma's @unique).
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

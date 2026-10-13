-- There is no separate company email any more: the login email is the only address, so the second sign-in/company
-- address column (and its unique index) is dropped.
DROP INDEX IF EXISTS "users_officialEmail_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "officialEmail";

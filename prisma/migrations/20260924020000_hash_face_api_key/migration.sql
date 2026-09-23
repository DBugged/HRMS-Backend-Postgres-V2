-- faceApiKey was stored in plaintext; switch to storing only its SHA-256
-- hash (same convention as resetPasswordToken / refresh tokens). Existing
-- keys are hashed in place below rather than invalidated, so any org that
-- already configured the punch webhook doesn't need to regenerate.
-- pgcrypto is a standard, trusted Postgres extension (available on RDS,
-- Supabase, Neon, and self-hosted Postgres alike) used here only to
-- compute the one-time backfill hash in SQL; the app itself still hashes
-- with Node's crypto module (see EmployeesService.issueSetPasswordLink)
-- for every hash it computes after this migration.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "organizations" ADD COLUMN "faceApiKeyHash" TEXT;

UPDATE "organizations"
SET "faceApiKeyHash" = encode(digest("faceApiKey", 'sha256'), 'hex')
WHERE "faceApiKey" IS NOT NULL;

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_faceApiKeyHash_key" UNIQUE ("faceApiKeyHash");

ALTER TABLE "organizations" DROP COLUMN "faceApiKey";

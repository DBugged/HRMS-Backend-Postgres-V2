-- Keeps the platform status (ARCHIVED used to collapse into "active") next to the isActive flag the app enforces.
ALTER TABLE "organizations" ADD COLUMN "platformStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
UPDATE "organizations" SET "platformStatus" = 'SUSPENDED' WHERE "isActive" = false;

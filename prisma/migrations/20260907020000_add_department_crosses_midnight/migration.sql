-- AlterTable: opt-in overnight-shift flag, default false preserves all
-- existing behavior for every department until explicitly enabled.
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "crossesMidnight" BOOLEAN NOT NULL DEFAULT false;

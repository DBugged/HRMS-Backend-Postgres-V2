-- Per-leave-type "Count in total balance" flag, replacing the hardcoded code
-- lists the web/mobile dashboards (EL/CL/SL/SPL only) and profiles (all
-- except ML/PTL/ADL) each used. On by default (custom types count); off for
-- the built-in one-off, event-based types, matched by their seeded codes.
ALTER TABLE "leave_types" ADD COLUMN "countInTotalBalance" BOOLEAN NOT NULL DEFAULT true;

UPDATE "leave_types"
SET "countInTotalBalance" = false
WHERE "isSystemDefault" = true
  AND "code" IN ('ML', 'PTL', 'ADL', 'BL', 'MRL', 'STL');

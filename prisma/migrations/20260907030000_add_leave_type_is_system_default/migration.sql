-- AlterTable: marks the rows seedDefaults() created at registration so the
-- app can lock their name/code and block deletion (see reserved-codes.ts's
-- LEAVE_TYPE_CODES.COMPOFF coupling). Default false preserves current
-- (fully editable) behavior for anything not backfilled below.
ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "isSystemDefault" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every org's leave-type `code` is unique (assertNoDuplicate), so
-- a row matching one of the seeded default codes is that org's seeded
-- default — there's no other way a second row with the same code could
-- exist. Matches leave-type-defaults.ts's code list exactly.
UPDATE "leave_types"
SET "isSystemDefault" = true
WHERE "code" IN ('EL', 'LWP', 'COMPOFF', 'SL', 'CL', 'ML', 'PTL', 'ADL', 'BL', 'MRL', 'STL', 'SBL', 'SPL', 'PRL');

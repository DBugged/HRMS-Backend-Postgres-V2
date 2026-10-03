-- Per-employee selfie-at-punch override. DEFAULT = follow the org setting
-- (orgPayrollAttendancePrefs.requireSelfieForPunch, unset = required), so
-- every existing employee keeps today's behaviour.
CREATE TYPE "SelfieRequirement" AS ENUM ('DEFAULT', 'REQUIRED', 'NOT_REQUIRED');
ALTER TABLE "users" ADD COLUMN "selfieRequirement" "SelfieRequirement" NOT NULL DEFAULT 'DEFAULT';

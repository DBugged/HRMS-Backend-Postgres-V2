-- Per-employee location rule for check-in/out (DEFAULT follows the organization's attendance prefs):
--   ENFORCED    - location is read and, when a work location is assigned, the person must be inside it (today's rule)
--   RECORD_ONLY - location is read and stored but never blocks a punch (field staff)
--   NOT_NEEDED  - no location is taken at all (a selfie alone)
CREATE TYPE "LocationRequirement" AS ENUM ('DEFAULT', 'ENFORCED', 'RECORD_ONLY', 'NOT_NEEDED');

ALTER TABLE "users" ADD COLUMN "locationRequirement" "LocationRequirement" NOT NULL DEFAULT 'DEFAULT';

-- A punch's selfie is stamped by the server (time, place, device battery); the unmodified photo is kept here.
ALTER TABLE "punches" ADD COLUMN "batteryPercent" INTEGER;
ALTER TABLE "punches" ADD COLUMN "selfieOriginalUrl" TEXT;

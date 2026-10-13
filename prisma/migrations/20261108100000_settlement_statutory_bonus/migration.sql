-- Full & Final: statutory bonus due / already paid in the accounting year, and whether the bonus was calculated.
ALTER TABLE "settlements"
  ADD COLUMN "statutoryBonusDue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "statutoryBonusPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "bonusAuto" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bonusDisqualified" BOOLEAN NOT NULL DEFAULT false;

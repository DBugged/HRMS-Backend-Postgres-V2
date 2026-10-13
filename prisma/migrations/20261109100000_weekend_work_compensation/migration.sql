-- Overtime suggested from an Excel attendance import, and how weekend/holiday work is compensated.
ALTER TYPE "OvertimeSource" ADD VALUE IF NOT EXISTS 'IMPORT';

ALTER TABLE "overtime_records"
  ADD COLUMN "compensationKey" TEXT,
  ADD COLUMN "payDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "compOffDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "compOffId" TEXT;

ALTER TABLE "payroll_settings" ADD COLUMN "workCompensation" JSONB NOT NULL DEFAULT '{}';

-- Day-based compensation is paid on top of the hourly part: Overtime Pay now adds OT_DAY_PAY_DAYS x (full-month Basic / 30).
UPDATE "salary_components"
SET "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC_RATE / 208) + OT_DAY_PAY_DAYS * (BASIC_RATE / 30), 0)'
WHERE "code" = 'OVERTIME_PAY'
  AND "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC_RATE / 208), 0)';

-- Org-configurable overtime multipliers (Payroll Settings), replacing the
-- hardcoded REGULAR 1.5 / HOLIDAY 2 / WEEKEND 2 / NIGHT 1.75 — same values
-- as defaults, so existing orgs are unaffected until they change them.
ALTER TABLE "payroll_settings" ADD COLUMN "otRegularRate" DOUBLE PRECISION NOT NULL DEFAULT 1.5;
ALTER TABLE "payroll_settings" ADD COLUMN "otHolidayRate" DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE "payroll_settings" ADD COLUMN "otWeekendRate" DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE "payroll_settings" ADD COLUMN "otNightRate" DOUBLE PRECISION NOT NULL DEFAULT 1.75;

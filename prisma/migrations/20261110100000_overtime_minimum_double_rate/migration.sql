-- Code on Wages, 2019, section 14 (in force 21-Nov-2025): overtime is paid at not less than twice the normal rate of wages.
ALTER TABLE "payroll_settings" ALTER COLUMN "otRegularRate" SET DEFAULT 2, ALTER COLUMN "otNightRate" SET DEFAULT 2;
UPDATE "payroll_settings" SET "otRegularRate" = 2 WHERE "otRegularRate" < 2;
UPDATE "payroll_settings" SET "otHolidayRate" = 2 WHERE "otHolidayRate" < 2;
UPDATE "payroll_settings" SET "otWeekendRate" = 2 WHERE "otWeekendRate" < 2;
UPDATE "payroll_settings" SET "otNightRate" = 2 WHERE "otNightRate" < 2;
-- Requests still waiting for approval are priced at the legal minimum; reviewed ones keep what they were approved at.
UPDATE "overtime_records" SET "rateMultiplier" = 2 WHERE "status" = 'PENDING' AND "rateMultiplier" < 2;

-- Drop unused default keys (leaveYearStartMonth, workingHoursStart/End,
-- language, defaultProbationDays, defaultRetirementAge) from
-- organizations.policies's column default. Existing rows are left as-is
-- (their stored JSON still carries these keys) — only new orgs stop
-- seeding the dead keys going forward.
ALTER TABLE "organizations"
  ALTER COLUMN "policies" SET DEFAULT '{"financialYearStartMonth":4,"timezone":"Asia/Kolkata","currency":"INR","currencySymbol":"₹","dateFormat":"DD-MM-YYYY","timeFormat":"24","defaultNoticeDays":30}'::jsonb;

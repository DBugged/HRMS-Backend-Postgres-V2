-- Payroll correctness fixes (additive only).
--
-- 1. payroll_runs.taxableGross: the month's taxable earnings, summed for year-to-date taxable income (YTD used to
--    sum grossSalary, which includes non-taxable pay). Nullable — existing runs are re-derived from their stored
--    earning lines' `taxable` flags at read time, falling back to grossSalary.
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "taxableGross" DOUBLE PRECISION;

-- 2. settlements.pendingSalaryBreakdown: the LWD-month payroll lines behind pendingSalaryAmount, so the final-settlement
--    payroll run carries the real earnings / statutory deductions / employer contributions instead of one net figure.
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "pendingSalaryBreakdown" JSONB;

-- 3. Overtime pay honours each overtime record's rateMultiplier (1.5x regular, 2x holiday/weekend, 1.75x night) via
--    the new OT_WEIGHTED_HOURS variable. Only the seeded default formula that is still EXACTLY the old text is
--    rewritten — a formula an admin customised is left alone. OT_HOURS itself is unchanged and still available.
UPDATE "salary_components" SET "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC / 200), 0)', "updatedAt" = now()
  WHERE "code" = 'OVERTIME_PAY' AND "isSystemDefault" AND "formula" = 'ROUND(OT_HOURS * (BASIC / 200), 0)';

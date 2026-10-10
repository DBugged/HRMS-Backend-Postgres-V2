-- Leave quotas are now always granted upfront (prorated for someone who joined part-way through the year); the
-- per-cycle Accrual Frequency is retired.
--
-- 1) A legacy "Earned" type credited a fixed amount every cycle: its yearly quota is that amount x cycles per year,
--    and it becomes an ordinary Fixed Annual type.
UPDATE "leave_types"
SET "annualQuota" = ROUND(
      ("accrualAmountPerCycle" * (CASE "accrualFrequency"::text
        WHEN 'MONTHLY' THEN 12
        WHEN 'BI_MONTHLY' THEN 6
        WHEN 'QUARTERLY' THEN 4
        WHEN 'HALF_YEARLY' THEN 2
        ELSE 1 END))::numeric, 2),
    "allocationType" = 'FIXED_ANNUAL'
WHERE "allocationType" = 'EARNED_MONTHLY' AND "accrualAmountPerCycle" > 0;

UPDATE "leave_types"
SET "allocationType" = 'FIXED_ANNUAL'
WHERE "allocationType" = 'EARNED_MONTHLY';

-- 2) Every type is Yearly (upfront) with no per-cycle amount.
UPDATE "leave_types"
SET "accrualFrequency" = 'YEARLY', "accrualAmountPerCycle" = 0
WHERE "accrualFrequency" <> 'YEARLY' OR "accrualAmountPerCycle" <> 0;

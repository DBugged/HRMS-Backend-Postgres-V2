-- Purpose: READ-ONLY report of employees whose Fixed Annual / Prorated on Joining leave balance was
--   inflated by a manual "Accrue" / "Run Accrual for All" before accrual was tied to Accrual Frequency —
--   those runs added accrualAmountPerCycle on top of the full upfront quota (EL 6 + 1.5/quarter -> 12).
-- Important: SELECT-only, changes nothing. "expected_max" is the most the row can legitimately hold
--   this year (full quota, or the prorated / joining-cycle share for someone who joined that year);
--   "excess_days" = credited - expected_max. Review before correcting.
-- Usage: psql "$DATABASE_URL" -f scripts/check-fixed-annual-accrual.sql

WITH rows AS (
  SELECT
    o."companyName"            AS organization,
    lt.code                    AS leave_type,
    lt."allocationType"        AS allocation_type,
    lt."annualQuota"           AS annual_quota,
    lt."accrualAmountPerCycle" AS per_cycle_now,
    u."employeeId"             AS employee_code,
    u.name                     AS employee_name,
    lb.year,
    lb."lastAccrualPeriod"     AS last_accrual_period,
    lb.credited,
    lb.closing,
    CASE
      -- Not a joining year: the whole quota.
      WHEN EXTRACT(YEAR FROM u."joiningDate") <> lb.year THEN lt."annualQuota"::numeric
      -- Credited per cycle (non-Yearly): every cycle from the joining cycle to year end.
      WHEN lt."accrualFrequency" <> 'YEARLY' THEN ROUND((lt."annualQuota" * (
        12 - FLOOR((EXTRACT(MONTH FROM u."joiningDate") - 1) / (12 / c.cycles)) * (12 / c.cycles)
      ) / 12)::numeric, 2)
      -- Yearly + prorated: months from joining to year end (computeUpfrontCredit).
      WHEN lt."allocationType" = 'PRORATED_ON_JOINING' OR lt."prorateOnJoining"
      THEN ROUND((lt."annualQuota" * (13 - EXTRACT(MONTH FROM u."joiningDate")) / 12)::numeric, 2)
      ELSE lt."annualQuota"::numeric
    END AS expected_max
  FROM leave_balances lb
  JOIN leave_types   lt ON lt.id = lb."leaveTypeId"
  JOIN users         u  ON u.id  = lb."employeeId"
  JOIN organizations o  ON o.id  = lb."organizationId"
  JOIN (VALUES ('YEARLY', 1), ('HALF_YEARLY', 2), ('QUARTERLY', 4), ('BI_MONTHLY', 6), ('MONTHLY', 12))
       AS c(freq, cycles) ON c.freq = lt."accrualFrequency"::text
  WHERE lt."allocationType" IN ('FIXED_ANNUAL', 'PRORATED_ON_JOINING')
    AND lb."lastAccrualPeriod" IS NOT NULL   -- accrual has run on this row at least once
)
SELECT *, ROUND((credited::numeric - expected_max), 2) AS excess_days
FROM rows
WHERE credited::numeric - expected_max > 0
ORDER BY organization, leave_type, year, employee_code;

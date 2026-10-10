-- Statutory bonus eligibility is tested on the monthly Basic + DA RATE (BASIC_DA_RATE), not on the prorated figure
-- of a part month. Existing organizations still carry the old seeded formula; update only rows that still have it
-- verbatim so a customised formula is left alone.
UPDATE "salary_components"
SET "formula" = 'IF(BASIC_DA_RATE <= BONUS_ELIGIBILITY_CEILING, ROUND(MIN(BASIC_DA, BONUS_CALC_CEILING) * BONUS_RATE / 100, 0), 0)'
WHERE "code" = 'BONUS_ACCRUAL'
  AND "formula" = 'IF(BASIC_DA <= BONUS_ELIGIBILITY_CEILING, ROUND(MIN(BASIC_DA, BONUS_CALC_CEILING) * BONUS_RATE / 100, 0), 0)';

-- Overtime Pay default formula: hourly rate = Basic / 208 (26 days x 8 hours), not the arbitrary / 200.
-- Only rows still carrying the exact previous default are touched; customised formulas are left alone.
UPDATE "salary_components"
SET "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC / 208), 0)'
WHERE "code" = 'OVERTIME_PAY'
  AND "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC / 200), 0)';

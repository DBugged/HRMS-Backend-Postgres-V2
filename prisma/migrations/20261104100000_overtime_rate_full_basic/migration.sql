-- Overtime Pay default formula: the hourly rate comes from the full-month Basic (BASIC_RATE), not the part-month Basic
-- that has already been cut by attendance proration. Only rows still carrying the exact previous default are touched;
-- customised formulas are left alone.
UPDATE "salary_components"
SET "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC_RATE / 208), 0)'
WHERE "code" = 'OVERTIME_PAY'
  AND "formula" = 'ROUND(OT_WEIGHTED_HOURS * (BASIC / 208), 0)';

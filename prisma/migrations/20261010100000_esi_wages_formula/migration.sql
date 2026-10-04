-- ESIC wages exclude non-monthly pay: point the ESI formulas at ESI_WAGES instead of GROSS_EARNINGS.
UPDATE "salary_components"
SET "formula" = REPLACE("formula", 'GROSS_EARNINGS', 'ESI_WAGES')
WHERE "code" IN ('ESI', 'ESI_EMPLOYER') AND "formula" LIKE '%ROUND(GROSS_EARNINGS * ESI_%';

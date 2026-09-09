-- The default Professional Tax formula spelled out exactly three slabs, so
-- it threw 'Unknown reference "PT_SLAB3_AMOUNT"' for an org with two (every
-- affected employee landed in the payroll run's failures[]) and silently
-- capped a four-slab org at slab 3's amount. PT_SLAB_AMOUNT() resolves
-- against whatever slabs the org has configured.
--
-- Matched on the exact seeded string, so any org that has customized its own
-- PT formula is left untouched.
UPDATE "salary_components"
SET "formula" = 'PT_SLAB_AMOUNT(GROSS_EARNINGS)'
WHERE "statutoryKey" = 'PT'
  AND "formula" = 'IF(GROSS_EARNINGS <= PT_SLAB1_UPTO, PT_SLAB1_AMOUNT, IF(GROSS_EARNINGS <= PT_SLAB2_UPTO, PT_SLAB2_AMOUNT, PT_SLAB3_AMOUNT))';

-- Data-only backfill: give every organization the FY 2026-27 income-tax slab set for BOTH regimes where one is
-- missing. Payroll silently skips TDS for an employee whose FY/regime has no slab config, and employees with no
-- declaration default to the NEW regime, so an org that only had one regime was under-withholding.
-- Values are the current statute (Budget 2026 changed none of them): NEW regime nil to 4L then 5-30%, standard
-- deduction 75,000, rebate up to 12L of 60,000; OLD regime 2.5L/5L/10L slabs, standard deduction 50,000, rebate
-- up to 5L of 12,500. Existing rows are left untouched (unique on organizationId + financialYear + regime).
INSERT INTO "tax_slab_configs" ("id", "organizationId", "financialYear", "regime", "slabs", "standardDeduction", "cessRate", "surchargeSlabs", "rebate87ALimit", "rebate87AAmount", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", '2026-27', 'NEW'::"TaxRegime",
  '[{"from":0,"to":400000,"rate":0},{"from":400000,"to":800000,"rate":5},{"from":800000,"to":1200000,"rate":10},{"from":1200000,"to":1600000,"rate":15},{"from":1600000,"to":2000000,"rate":20},{"from":2000000,"to":2400000,"rate":25},{"from":2400000,"to":null,"rate":30}]'::jsonb,
  75000, 4,
  '[{"from":5000000,"to":10000000,"rate":10},{"from":10000000,"to":20000000,"rate":15},{"from":20000000,"to":null,"rate":25}]'::jsonb,
  1200000, 60000, true, now(), now()
FROM "organizations" o
ON CONFLICT ("organizationId", "financialYear", "regime") DO NOTHING;

INSERT INTO "tax_slab_configs" ("id", "organizationId", "financialYear", "regime", "slabs", "standardDeduction", "cessRate", "surchargeSlabs", "rebate87ALimit", "rebate87AAmount", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", '2026-27', 'OLD'::"TaxRegime",
  '[{"from":0,"to":250000,"rate":0},{"from":250000,"to":500000,"rate":5},{"from":500000,"to":1000000,"rate":20},{"from":1000000,"to":null,"rate":30}]'::jsonb,
  50000, 4,
  '[{"from":5000000,"to":10000000,"rate":10},{"from":10000000,"to":20000000,"rate":15},{"from":20000000,"to":50000000,"rate":25},{"from":50000000,"to":null,"rate":37}]'::jsonb,
  500000, 12500, true, now(), now()
FROM "organizations" o
ON CONFLICT ("organizationId", "financialYear", "regime") DO NOTHING;

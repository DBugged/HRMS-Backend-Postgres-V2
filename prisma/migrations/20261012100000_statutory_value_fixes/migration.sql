-- 1) PF versions that already use the Rs 25,000 wage ceiling still carried the old Rs 75 EDLI cap; the cap is 0.5%
--    of the ceiling, i.e. Rs 125.
UPDATE "statutory_config_versions"
SET "config" = jsonb_set("config"::jsonb, '{edliMaxAmount}', '125'::jsonb)
WHERE "module" = 'PF'
  AND ("config"::jsonb ->> 'wageCeiling')::numeric >= 25000
  AND ("config"::jsonb ->> 'edliMaxAmount')::numeric = 75;

-- 2) Before tax year 2026-27 only Mumbai, Delhi, Chennai and Kolkata were metro for HRA. Earlier declarations that
--    picked one of the four cities added from 1-Apr-2026 were marked metro; correct them.
UPDATE "employee_tax_declarations"
SET "isMetroCity" = false
WHERE "financialYear" < '2026-27'
  AND "hraCity" IN ('Hyderabad', 'Bengaluru', 'Pune', 'Ahmedabad')
  AND "isMetroCity" = true;

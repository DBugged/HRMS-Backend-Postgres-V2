-- Data-only: statutory salary components stay stored-active; their on/off is shown from the Statutory
-- Compliance switch and enforced per pay-period date by payroll (statutory-overlay). Restores rows that had
-- been switched off by hand, which would otherwise drop them from payroll once the module is enabled.
UPDATE "salary_components"
SET "isActive" = true, "updatedAt" = now()
WHERE "statutoryKey"::text IN ('PF', 'ESI', 'PT', 'LWF', 'NPS', 'GRATUITY', 'BONUS') AND "isActive" = false;

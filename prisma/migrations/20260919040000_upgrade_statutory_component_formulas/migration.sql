-- Brings existing organizations' seeded statutory salary components up to the current rules. Only formulas that are
-- still EXACTLY the old seeded default are rewritten — a formula an admin customised is left alone. Each rewrite is
-- behaviourally identical until a new input is used: PF/gratuity/NPS wage bases become Basic + DA (DA is 0 unless the
-- org uses a DA component), and ESI keeps an employee covered for the rest of the contribution period (Apr-Sep /
-- Oct-Mar). Also adds the employer-only EDLI, EPF admin-charge and statutory-bonus accrual components where missing
-- (they only apply once the PF / Bonus module is enabled).
UPDATE "salary_components" SET "formula" = 'ROUND(MIN(PF_WAGES, PF_WAGE_CEILING) * PF_EMPLOYEE_RATE / 100, 0)', "updatedAt" = now()
  WHERE "code" = 'PF' AND "isSystemDefault" AND "formula" = 'ROUND(MIN(BASIC, PF_WAGE_CEILING) * PF_EMPLOYEE_RATE / 100, 0)';
UPDATE "salary_components" SET "formula" = 'ROUND(MIN(PF_WAGES, PF_WAGE_CEILING) * PF_EMPLOYER_RATE / 100, 0)', "updatedAt" = now()
  WHERE "code" = 'PF_EMPLOYER' AND "isSystemDefault" AND "formula" = 'ROUND(MIN(BASIC, PF_WAGE_CEILING) * PF_EMPLOYER_RATE / 100, 0)';
UPDATE "salary_components" SET "formula" = 'IF(ESI_APPLICABLE == 1, ROUND(GROSS_EARNINGS * ESI_EMPLOYEE_RATE / 100, 0), 0)', "updatedAt" = now()
  WHERE "code" = 'ESI' AND "isSystemDefault" AND "formula" = 'IF(GROSS_EARNINGS <= ESI_WAGE_CEILING, ROUND(GROSS_EARNINGS * ESI_EMPLOYEE_RATE / 100, 0), 0)';
UPDATE "salary_components" SET "formula" = 'IF(ESI_APPLICABLE == 1, ROUND(GROSS_EARNINGS * ESI_EMPLOYER_RATE / 100, 0), 0)', "updatedAt" = now()
  WHERE "code" = 'ESI_EMPLOYER' AND "isSystemDefault" AND "formula" = 'IF(GROSS_EARNINGS <= ESI_WAGE_CEILING, ROUND(GROSS_EARNINGS * ESI_EMPLOYER_RATE / 100, 0), 0)';
UPDATE "salary_components" SET "formula" = 'PERCENT(NPS_WAGES, NPS_EMPLOYER_RATE)', "updatedAt" = now()
  WHERE "code" = 'NPS_EMPLOYER' AND "isSystemDefault" AND "formula" = 'PERCENT(BASIC, NPS_EMPLOYER_RATE)';
UPDATE "salary_components" SET "formula" = 'PERCENT(GRATUITY_WAGES, GRATUITY_RATE)', "updatedAt" = now()
  WHERE "code" = 'GRATUITY_ACCRUAL' AND "isSystemDefault" AND "formula" = 'PERCENT(BASIC, GRATUITY_RATE)';

INSERT INTO "salary_components" ("id", "organizationId", "name", "code", "type", "calcType", "formula", "isStatutory", "statutoryKey", "isEmployerContribution", "includeInGross", "includeInNet", "displayOrder", "isSystemDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", c."name", c."code", 'EARNING'::"SalaryComponentType", 'FORMULA'::"CalcType", c."formula", true, c."key"::"StatutoryKey", true, false, false, c."ord", true, now(), now()
FROM "organizations" o
CROSS JOIN (VALUES
  ('Employer EDLI Contribution', 'EDLI_EMPLOYER', 'MIN(PF_EDLI_MAX, ROUND(MIN(PF_WAGES, PF_WAGE_CEILING) * PF_EDLI_RATE / 100, 0))', 'PF', 45),
  ('EPF Administration Charges', 'EPF_ADMIN_EMPLOYER', 'ROUND(MIN(PF_WAGES, PF_WAGE_CEILING) * PF_ADMIN_RATE / 100, 0)', 'PF', 46),
  ('Statutory Bonus (Accrual)', 'BONUS_ACCRUAL', 'IF(BASIC_DA <= BONUS_ELIGIBILITY_CEILING, ROUND(MIN(BASIC_DA, BONUS_CALC_CEILING) * BONUS_RATE / 100, 0), 0)', 'BONUS', 47)
) AS c("name", "code", "formula", "key", "ord")
WHERE NOT EXISTS (SELECT 1 FROM "salary_components" s WHERE s."organizationId" = o."id" AND s."code" = c."code");

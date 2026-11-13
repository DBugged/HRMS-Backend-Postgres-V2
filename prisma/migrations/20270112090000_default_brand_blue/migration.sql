-- The default brand colour is now blue (#0646b8) instead of indigo (#5546e0).
-- New companies and new payslip templates start with it; a company can still pick its own colour in Branding.
-- Rows that still hold the old default were never customised, so they follow the new default. Any other colour is left alone.
ALTER TABLE "organizations" ALTER COLUMN "primaryColor" SET DEFAULT '#0646b8';
UPDATE "organizations" SET "primaryColor" = '#0646b8' WHERE lower("primaryColor") = '#5546e0';

ALTER TABLE "payroll_templates" ALTER COLUMN "primaryColor" SET DEFAULT '#0646b8';
UPDATE "payroll_templates" SET "primaryColor" = '#0646b8' WHERE lower("primaryColor") = '#5546e0';

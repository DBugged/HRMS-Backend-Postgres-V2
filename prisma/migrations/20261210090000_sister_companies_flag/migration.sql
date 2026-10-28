-- The switch for sister companies (company names and employee ID series per sister company). OFF by default: a Super Admin turns it on
-- for a company under Organization > Features. Idempotent.
INSERT INTO "cc_feature_flags" ("key","description","defaultValue","status","updatedAt") VALUES
('feature.sister_companies','Sister companies: a name, logo and employee ID series per sister company on payslips, letters and emails. Off by default.','false','ACTIVE',now())
ON CONFLICT ("key") DO NOTHING;

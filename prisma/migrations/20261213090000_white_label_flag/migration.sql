-- Removes our branding ("D'Core HR by D'Bugged Programmers" credit) from the web and mobile app for a company that has paid for it. OFF by
-- default; a Super Admin turns it on per company under Organization > Features, once the company has uploaded its own logo. Idempotent.
INSERT INTO "cc_feature_flags" ("key","description","defaultValue","status","updatedAt") VALUES
('feature.white_label','White label: hide our branding (D''Core HR by D''Bugged Programmers) in the web and mobile app for this company. Needs the company logo uploaded. Off by default.','false','ACTIVE',now())
ON CONFLICT ("key") DO NOTHING;

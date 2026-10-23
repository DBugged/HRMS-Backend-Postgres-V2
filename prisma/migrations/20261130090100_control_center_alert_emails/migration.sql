-- Email a digest of new Control Panel alerts (sign-ups, overdue invoices, pilots ended...) to Owners and Admins. On by default.
INSERT INTO "cc_settings" ("key","value","type","restricted","description","updatedAt") VALUES
('platform.email_alerts','true','bool',false,'Email Owners and Admins when the daily job raises new alerts.',now())
ON CONFLICT ("key") DO NOTHING;

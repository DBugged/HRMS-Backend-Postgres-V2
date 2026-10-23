-- One flag per HRMS module so a Super Admin can switch a module on or off for a single company (Organization > Features).
-- Default is on. Idempotent. NOTE: the HRMS app does not read these yet; they are the control surface for enforcement.
INSERT INTO "cc_feature_flags" ("key","description","defaultValue","status","updatedAt") VALUES
('module.attendance','Attendance, shifts, geo-fencing and regularization','true','ACTIVE',now()),
('module.leave','Leave types, balances, encashment, comp-off','true','ACTIVE',now()),
('module.payroll','Payroll runs, payslips, salary structures','true','ACTIVE',now()),
('module.statutory','PF, ESI, Professional Tax, LWF, TDS compliance','true','ACTIVE',now()),
('module.loans_reimbursements','Loans, advances and reimbursements','true','ACTIVE',now()),
('module.assets','Asset inventory and assignment','true','ACTIVE',now()),
('module.performance','Performance ratings and company performance','true','ACTIVE',now()),
('module.documents_letters','Employee documents and letter generation','true','ACTIVE',now()),
('module.offboarding','Resignation, settlement and exit','true','ACTIVE',now()),
('module.reports','Reports and analytics','true','ACTIVE',now()),
('module.policy_assistant','AI policy assistant','true','ACTIVE',now()),
('module.mobile_app','Employee mobile app access','true','ACTIVE',now())
ON CONFLICT ("key") DO NOTHING;

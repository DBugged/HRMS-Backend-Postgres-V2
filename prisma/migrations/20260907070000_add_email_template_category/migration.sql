-- Adds EmailTemplate.category, defaulting every existing row to 'General',
-- then backfills the correct category onto every built-in (isCustom = false)
-- row using its occasionKey. Custom rows are left at 'General' (editable
-- afterward, same as any other field).
ALTER TABLE "email_templates" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'General';

UPDATE "email_templates" SET "category" = CASE "occasionKey"
  WHEN 'BIRTHDAY' THEN 'General'
  WHEN 'NEW_JOINER_ANNOUNCEMENT' THEN 'General'
  WHEN 'WORK_ANNIVERSARY' THEN 'General'
  WHEN 'ABSENT_MARKED' THEN 'Attendance'
  WHEN 'WFH_DECISION' THEN 'Attendance'
  WHEN 'REGULARIZATION_DECISION' THEN 'Attendance'
  WHEN 'LEAVE_DECISION' THEN 'Leave & Comp-Off'
  WHEN 'COMP_OFF_DECISION' THEN 'Leave & Comp-Off'
  WHEN 'OVERTIME_STATUS' THEN 'Leave & Comp-Off'
  WHEN 'LEAVE_ENCASHMENT_STATUS' THEN 'Leave & Comp-Off'
  WHEN 'LOAN_SANCTIONED' THEN 'Payroll & Finance'
  WHEN 'LOAN_STATUS_UPDATE' THEN 'Payroll & Finance'
  WHEN 'REIMBURSEMENT_STATUS' THEN 'Payroll & Finance'
  WHEN 'PAYSLIP_ISSUED' THEN 'Payroll & Finance'
  WHEN 'TAX_DECLARATION_VERIFIED' THEN 'Payroll & Finance'
  WHEN 'PERFORMANCE_RATING_PUBLISHED' THEN 'Payroll & Finance'
  WHEN 'OFFBOARDING_INITIATED' THEN 'Exit'
  WHEN 'SETTLEMENT_PROCESSED' THEN 'Exit'
  WHEN 'DOCUMENT_STATUS' THEN 'Documents'
  WHEN 'LETTER_SENT' THEN 'Documents'
  WHEN 'WELCOME_EMAIL' THEN 'Account & Access'
  WHEN 'LOGIN_CREDENTIALS_RESENT' THEN 'Account & Access'
  WHEN 'FOUNDER_ACCOUNT_WELCOME' THEN 'Account & Access'
  WHEN 'PASSWORD_RESET' THEN 'Account & Access'
  WHEN 'ACCOUNT_ACTIVATED' THEN 'Account & Access'
  WHEN 'SETUP_COMPLETE' THEN 'Account & Access'
  ELSE "category"
END
WHERE "isCustom" = false;

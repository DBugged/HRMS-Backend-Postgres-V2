-- Payroll Settings: optionally require HR-verified tax declarations before they affect TDS.
ALTER TABLE "payroll_settings" ADD COLUMN "taxDeclarationRequiresVerification" BOOLEAN NOT NULL DEFAULT false;

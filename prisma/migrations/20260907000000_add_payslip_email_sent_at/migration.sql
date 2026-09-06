-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "payslipEmailSentAt" TIMESTAMP(3);

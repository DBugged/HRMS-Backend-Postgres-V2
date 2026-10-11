-- Payment tracking on payroll runs (bank UTR, mode, date). Additive.
ALTER TABLE "payroll_runs" ADD COLUMN "paymentMode" TEXT;
ALTER TABLE "payroll_runs" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "payroll_runs" ADD COLUMN "paymentDate" TEXT;

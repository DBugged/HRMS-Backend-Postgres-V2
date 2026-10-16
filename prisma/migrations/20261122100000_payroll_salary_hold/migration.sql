-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN "heldAt" TIMESTAMP(3),
ADD COLUMN "heldById" TEXT,
ADD COLUMN "holdReason" TEXT;

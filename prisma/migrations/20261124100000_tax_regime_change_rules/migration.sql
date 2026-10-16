-- AlterTable
ALTER TABLE "payroll_settings" ADD COLUMN "taxRegimeEmployeeChange" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "taxRegimeCutoffMonth" INTEGER;

-- AlterTable
ALTER TABLE "employee_tax_declarations" ADD COLUMN "regimeChangeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "regimeChangedAt" TIMESTAMP(3);

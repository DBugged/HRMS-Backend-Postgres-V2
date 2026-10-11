-- Supplementary (off-cycle) payroll runs: several runs per employee and month, told apart by runSequence
-- (0 = the regular run, so every existing row keeps its identity). Additive except the unique index, which is widened.
ALTER TABLE "payroll_runs" ADD COLUMN "runSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payroll_runs" ADD COLUMN "runLabel" TEXT;
DROP INDEX "payroll_runs_employeeId_month_year_isFinalSettlement_key";
CREATE UNIQUE INDEX "payroll_runs_employeeId_month_year_isFinalSettlement_runSequence_key" ON "payroll_runs"("employeeId", "month", "year", "isFinalSettlement", "runSequence");

-- Marks a payroll run whose attendance/leave/overtime inputs changed after it was calculated (it must be recalculated
-- before it can be verified, approved or locked). Additive; existing runs are not marked.
ALTER TABLE "payroll_runs" ADD COLUMN "inputsChangedAt" TIMESTAMP(3);

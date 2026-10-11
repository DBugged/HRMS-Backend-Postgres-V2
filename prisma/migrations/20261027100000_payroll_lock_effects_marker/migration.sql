-- Marks that a lock's loan/encashment side effects were applied, so a crash between the status change and the effects
-- can be detected and repaired. Existing locked/paid runs are treated as applied.
ALTER TABLE "payroll_runs" ADD COLUMN "lockEffectsAppliedAt" TIMESTAMP(3);
UPDATE "payroll_runs" SET "lockEffectsAppliedAt" = COALESCE("lockedAt", "updatedAt") WHERE "status" IN ('LOCKED', 'PAID');

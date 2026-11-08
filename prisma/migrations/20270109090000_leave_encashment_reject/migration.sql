-- A leave encashment request can now be rejected, with the reason kept for the employee to see.
ALTER TYPE "LeaveEncashmentStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TABLE "leave_encashments" ADD COLUMN IF NOT EXISTS "decisionNote" TEXT NOT NULL DEFAULT '';

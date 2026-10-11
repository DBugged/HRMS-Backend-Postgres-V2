-- Periodic leave accrual: per-type mode / timing / cap, and the ledger of credits. Additive; every existing leave type
-- stays UPFRONT.
CREATE TYPE "LeaveAccrualMode" AS ENUM ('UPFRONT', 'PERIODIC');
CREATE TYPE "AccrualTiming" AS ENUM ('START', 'END');
CREATE TYPE "LeaveAccrualSource" AS ENUM ('SCHEDULED', 'MANUAL');

ALTER TABLE "leave_types" ADD COLUMN "accrualMode" "LeaveAccrualMode" NOT NULL DEFAULT 'UPFRONT';
ALTER TABLE "leave_types" ADD COLUMN "accrueAt" "AccrualTiming" NOT NULL DEFAULT 'END';
ALTER TABLE "leave_types" ADD COLUMN "maxBalance" DOUBLE PRECISION;
ALTER TABLE "leave_types" ADD COLUMN "periodicFromYear" INTEGER;

CREATE TABLE "leave_accrual_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "days" DOUBLE PRECISION NOT NULL,
    "source" "LeaveAccrualSource" NOT NULL DEFAULT 'SCHEDULED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_accrual_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "leave_accrual_entries_organizationId_employeeId_leaveTypeId_periodStart_key" ON "leave_accrual_entries"("organizationId", "employeeId", "leaveTypeId", "periodStart");
CREATE INDEX "leave_accrual_entries_organizationId_employeeId_year_idx" ON "leave_accrual_entries"("organizationId", "employeeId", "year");
ALTER TABLE "leave_accrual_entries" ADD CONSTRAINT "leave_accrual_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_accrual_entries" ADD CONSTRAINT "leave_accrual_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_accrual_entries" ADD CONSTRAINT "leave_accrual_entries_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

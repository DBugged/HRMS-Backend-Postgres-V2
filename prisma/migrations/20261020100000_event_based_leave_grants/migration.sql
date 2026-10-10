-- Event-based (grant-based) leave: an additive allocation type, per-type grant settings and an auditable grant ledger.
-- No existing leave type or balance is changed.
ALTER TYPE "AllocationType" ADD VALUE IF NOT EXISTS 'EVENT_BASED';

ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "eventGrant" JSONB NOT NULL DEFAULT '{}';

CREATE TYPE "LeaveGrantStatus" AS ENUM ('ACTIVE', 'REVERSED');

CREATE TABLE "leave_grants" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "eventDate" TEXT NOT NULL,
  "effectiveDate" TEXT NOT NULL,
  "days" DOUBLE PRECISION NOT NULL,
  "balanceYear" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "documentRef" TEXT,
  "idempotencyKey" TEXT,
  "status" "LeaveGrantStatus" NOT NULL DEFAULT 'ACTIVE',
  "grantedById" TEXT NOT NULL,
  "reversedAt" TIMESTAMP(3),
  "reversedById" TEXT,
  "reversalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_grants_organizationId_idempotencyKey_key" ON "leave_grants"("organizationId", "idempotencyKey");
CREATE INDEX "leave_grants_organizationId_employeeId_leaveTypeId_idx" ON "leave_grants"("organizationId", "employeeId", "leaveTypeId");
-- One ACTIVE grant per employee, leave type and event date: concurrent or repeated grants for the same event cannot
-- both succeed (a reversed grant frees the event for a corrected grant).
CREATE UNIQUE INDEX "leave_grants_one_active_per_event" ON "leave_grants"("organizationId", "employeeId", "leaveTypeId", "eventDate") WHERE "status" = 'ACTIVE';

ALTER TABLE "leave_grants" ADD CONSTRAINT "leave_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grants" ADD CONSTRAINT "leave_grants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grants" ADD CONSTRAINT "leave_grants_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grants" ADD CONSTRAINT "leave_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grants" ADD CONSTRAINT "leave_grants_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

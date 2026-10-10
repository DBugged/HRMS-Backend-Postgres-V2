-- Employee requests for event-based leave grants (approved by HR/Admin into a LeaveGrant). Additive only.
CREATE TYPE "LeaveGrantRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "leave_grant_requests" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "eventDate" TEXT NOT NULL,
  "days" DOUBLE PRECISION NOT NULL,
  "reason" TEXT NOT NULL,
  "documentRef" TEXT,
  "status" "LeaveGrantRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "grantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_grant_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_grant_requests_organizationId_status_idx" ON "leave_grant_requests"("organizationId", "status");
CREATE INDEX "leave_grant_requests_organizationId_employeeId_idx" ON "leave_grant_requests"("organizationId", "employeeId");
-- One open request per employee, leave type and event date, even under concurrent submits.
CREATE UNIQUE INDEX "leave_grant_requests_one_pending" ON "leave_grant_requests"("organizationId", "employeeId", "leaveTypeId", "eventDate") WHERE "status" = 'PENDING';

ALTER TABLE "leave_grant_requests" ADD CONSTRAINT "leave_grant_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grant_requests" ADD CONSTRAINT "leave_grant_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grant_requests" ADD CONSTRAINT "leave_grant_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_grant_requests" ADD CONSTRAINT "leave_grant_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

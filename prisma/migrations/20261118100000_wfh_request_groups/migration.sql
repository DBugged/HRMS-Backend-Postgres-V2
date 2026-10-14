-- A Work From Home request can cover several days. Each day is still its own attendance row (that is where the
-- arrangement and its review live), but the rows of one request share this id so the approver sees and decides it as
-- one request. Null for a single-day request made the old way.
ALTER TABLE "attendances" ADD COLUMN "wfhRequestId" TEXT;

CREATE INDEX "attendances_organizationId_wfhRequestId_idx" ON "attendances"("organizationId", "wfhRequestId");

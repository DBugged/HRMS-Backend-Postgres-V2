-- Regularization: a history of every request (not just the one in force), an optional supporting document, and a
-- configurable lookback window (was fixed at 7 days). Additive.
ALTER TABLE "organizations" ADD COLUMN "regularizationWindowDays" INTEGER NOT NULL DEFAULT 7;

CREATE TYPE "RegularizationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "attendance_regularization_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedInTime" TIMESTAMP(3),
    "requestedOutTime" TIMESTAMP(3),
    "evidenceUrl" TEXT,
    "status" "RegularizationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComments" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_regularization_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_regularization_requests_organizationId_employeeId_date_idx" ON "attendance_regularization_requests"("organizationId", "employeeId", "date");
CREATE INDEX "attendance_regularization_requests_attendanceId_createdAt_idx" ON "attendance_regularization_requests"("attendanceId", "createdAt");

ALTER TABLE "attendance_regularization_requests" ADD CONSTRAINT "attendance_regularization_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_regularization_requests" ADD CONSTRAINT "attendance_regularization_requests_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "attendances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_regularization_requests" ADD CONSTRAINT "attendance_regularization_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry over the request each day currently holds, so the history starts with what is already on record.
INSERT INTO "attendance_regularization_requests"
    ("id", "organizationId", "attendanceId", "employeeId", "date", "reason", "requestedInTime", "requestedOutTime",
     "status", "autoApproved", "reviewedById", "reviewedAt", "reviewComments", "createdAt", "updatedAt")
SELECT
    md5(a."id" || 'regularization'),
    a."organizationId", a."id", a."employeeId", a."date",
    COALESCE(a."regularization"->>'reason', ''),
    (NULLIF(a."regularization"->>'requestedInTime', '')::timestamptz) AT TIME ZONE 'UTC',
    (NULLIF(a."regularization"->>'requestedOutTime', '')::timestamptz) AT TIME ZONE 'UTC',
    CASE a."regularization"->>'status'
        WHEN 'approved' THEN 'APPROVED'
        WHEN 'rejected' THEN 'REJECTED'
        ELSE 'PENDING' END::"RegularizationRequestStatus",
    COALESCE(a."regularization"->>'reviewComments', '') LIKE 'Auto-approved:%',
    NULLIF(a."regularization"->>'reviewedBy', ''),
    (NULLIF(a."regularization"->>'reviewedAt', '')::timestamptz) AT TIME ZONE 'UTC',
    COALESCE(a."regularization"->>'reviewComments', ''),
    a."updatedAt", a."updatedAt"
FROM "attendances" a
WHERE a."regularization"->>'status' IN ('pending', 'approved', 'rejected');

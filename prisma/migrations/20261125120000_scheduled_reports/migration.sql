-- Reports emailed on a schedule (Reports > Scheduled).
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "frequency" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "sendHour" INTEGER NOT NULL DEFAULT 8,
    "recipients" TEXT[],
    "departmentId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "lastRunDate" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_reports_organizationId_idx" ON "scheduled_reports"("organizationId");

ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

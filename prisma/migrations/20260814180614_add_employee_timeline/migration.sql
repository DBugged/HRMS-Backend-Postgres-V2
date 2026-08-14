-- CreateEnum
CREATE TYPE "TimelineCategory" AS ENUM ('RECRUITMENT', 'EMPLOYMENT', 'ORGANIZATION', 'PAYROLL', 'ATTENDANCE_LEAVE', 'PERFORMANCE', 'COMPLIANCE', 'EXIT');

-- CreateTable
CREATE TABLE "employee_timeline" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" "TimelineCategory" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedById" TEXT,
    "remarks" TEXT DEFAULT '',
    "relatedDocument" TEXT DEFAULT '',
    "status" TEXT DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_timeline_organizationId_employeeId_occurredAt_idx" ON "employee_timeline"("organizationId", "employeeId", "occurredAt");

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

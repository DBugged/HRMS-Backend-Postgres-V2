-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "workScheduleId" TEXT;

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workingDays" JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_schedules_organizationId_idx" ON "work_schedules"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_organizationId_name_key" ON "work_schedules"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workScheduleId_fkey" FOREIGN KEY ("workScheduleId") REFERENCES "work_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

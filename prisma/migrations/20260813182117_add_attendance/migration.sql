-- CreateEnum
CREATE TYPE "PunchSource" AS ENUM ('FACE_API', 'EXCEL_IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'HOLIDAY', 'WEEKLY_OFF', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "WorkArrangement" AS ENUM ('OFFICE', 'WFH', 'HYBRID', 'CLIENT_SITE');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('FACE_API', 'EXCEL_IMPORT', 'REGULARIZED', 'SYSTEM');

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "earlyOutThresholdMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "lateInThresholdMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "minHoursForHalfDay" DOUBLE PRECISION NOT NULL DEFAULT 4,
ADD COLUMN     "minHoursForPresent" DOUBLE PRECISION NOT NULL DEFAULT 8,
ADD COLUMN     "shiftEndTime" TEXT NOT NULL DEFAULT '18:30',
ADD COLUMN     "shiftStartTime" TEXT NOT NULL DEFAULT '09:30',
ADD COLUMN     "weeklyOffs" JSONB NOT NULL DEFAULT '[0]',
ADD COLUMN     "workLocationId" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "attendancePayrollPrefs" JSONB NOT NULL DEFAULT '{"defaultShiftStartTime":"09:30","defaultShiftEndTime":"18:30","defaultLateInThresholdMinutes":15,"defaultEarlyOutThresholdMinutes":15,"defaultMinHoursForPresent":8,"defaultMinHoursForHalfDay":4,"weekendDays":[0,6]}',
ADD COLUMN     "enableWFH" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "punches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "punchTime" TIMESTAMP(3) NOT NULL,
    "source" "PunchSource" NOT NULL DEFAULT 'FACE_API',
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "selfieUrl" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "inTime" TIMESTAMP(3),
    "outTime" TIMESTAMP(3),
    "checkinLocation" TEXT,
    "checkinLatitude" DOUBLE PRECISION,
    "checkinLongitude" DOUBLE PRECISION,
    "checkinSelfieUrl" TEXT,
    "checkoutLocation" TEXT,
    "checkoutLatitude" DOUBLE PRECISION,
    "checkoutLongitude" DOUBLE PRECISION,
    "checkoutSelfieUrl" TEXT,
    "workDurationMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "workArrangement" "WorkArrangement" NOT NULL DEFAULT 'OFFICE',
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "isEarlyOut" BOOLEAN NOT NULL DEFAULT false,
    "source" "AttendanceSource" NOT NULL DEFAULT 'FACE_API',
    "regularization" JSONB NOT NULL DEFAULT '{"requested":false,"reason":"","requestedInTime":null,"requestedOutTime":null,"status":"none","reviewedBy":null,"reviewedAt":null,"reviewComments":""}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "punches_organizationId_employeeId_punchTime_idx" ON "punches"("organizationId", "employeeId", "punchTime");

-- CreateIndex
CREATE INDEX "attendances_organizationId_date_idx" ON "attendances"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_organizationId_employeeId_date_key" ON "attendances"("organizationId", "employeeId", "date");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punches" ADD CONSTRAINT "punches_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punches" ADD CONSTRAINT "punches_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

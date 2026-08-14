-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "HalfDaySession" AS ENUM ('FIRST_HALF', 'SECOND_HALF');

-- CreateEnum
CREATE TYPE "CompOffStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AVAILED', 'PARTIALLY_AVAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "leaves" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "isHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "halfDaySession" "HalfDaySession",
    "totalDays" DOUBLE PRECISION NOT NULL,
    "remarks" TEXT NOT NULL DEFAULT '',
    "attachmentUrl" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComments" TEXT NOT NULL DEFAULT '',
    "appliedOnBehalfOf" BOOLEAN NOT NULL DEFAULT false,
    "editedFromLeaveId" TEXT,
    "level1ApprovedById" TEXT,
    "level1ApprovedAt" TIMESTAMP(3),
    "level1Comments" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_offs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "earnedForDate" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "daysEarned" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "expiryDate" TEXT,
    "status" "CompOffStatus" NOT NULL DEFAULT 'PENDING',
    "daysAvailed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leaves_organizationId_idx" ON "leaves"("organizationId");

-- CreateIndex
CREATE INDEX "leaves_employeeId_idx" ON "leaves"("employeeId");

-- CreateIndex
CREATE INDEX "comp_offs_organizationId_idx" ON "comp_offs"("organizationId");

-- CreateIndex
CREATE INDEX "comp_offs_employeeId_idx" ON "comp_offs"("employeeId");

-- AddForeignKey
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_level1ApprovedById_fkey" FOREIGN KEY ("level1ApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_offs" ADD CONSTRAINT "comp_offs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_offs" ADD CONSTRAINT "comp_offs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_offs" ADD CONSTRAINT "comp_offs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

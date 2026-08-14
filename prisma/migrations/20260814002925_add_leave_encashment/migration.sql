-- CreateEnum
CREATE TYPE "LeaveEncashmentStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSED');

-- CreateTable
CREATE TABLE "leave_encashments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT,
    "days" DOUBLE PRECISION NOT NULL,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "financialYear" TEXT NOT NULL,
    "status" "LeaveEncashmentStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "payrollRunId" TEXT,
    "settlementRef" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_encashments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_encashments_organizationId_employeeId_idx" ON "leave_encashments"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "leave_encashments" ADD CONSTRAINT "leave_encashments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashments" ADD CONSTRAINT "leave_encashments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashments" ADD CONSTRAINT "leave_encashments_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashments" ADD CONSTRAINT "leave_encashments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

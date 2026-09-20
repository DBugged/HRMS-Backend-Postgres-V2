-- CreateEnum
CREATE TYPE "ResignationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EmployeeMovementType" AS ENUM ('TRANSFER', 'PROMOTION', 'MANAGER_CHANGE', 'DESIGNATION_CHANGE');

-- AlterTable
ALTER TABLE "offboarding_cases" ADD COLUMN     "assetOverrideNote" TEXT,
ADD COLUMN     "exitStatus" "EmploymentStatus" NOT NULL DEFAULT 'RELEASED',
ADD COLUMN     "previousEmploymentStatus" "EmploymentStatus";

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "reimbursementAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "departmentName" TEXT,
ADD COLUMN     "designation" TEXT,
ADD COLUMN     "gradeLevel" TEXT;

-- CreateTable
CREATE TABLE "resignations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "submittedOn" TEXT NOT NULL,
    "requestedLwd" TEXT NOT NULL,
    "approvedLwd" TEXT,
    "noticePeriodDays" INTEGER,
    "reason" TEXT,
    "status" "ResignationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "offboardingCaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resignations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "EmployeeMovementType" NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT,
    "previousDepartmentId" TEXT,
    "newDepartmentId" TEXT,
    "previousDesignation" TEXT,
    "newDesignation" TEXT,
    "previousGradeLevel" TEXT,
    "newGradeLevel" TEXT,
    "previousReportingManagerId" TEXT,
    "newReportingManagerId" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resignations_organizationId_employeeId_idx" ON "resignations"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "resignations_organizationId_status_idx" ON "resignations"("organizationId", "status");

-- CreateIndex
CREATE INDEX "employee_movements_organizationId_employeeId_idx" ON "employee_movements"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_targetId_idx" ON "audit_logs"("organizationId", "targetId");

-- CreateIndex
CREATE INDEX "leaves_organizationId_employeeId_startDate_idx" ON "leaves"("organizationId", "employeeId", "startDate");

-- CreateIndex
CREATE INDEX "users_organizationId_reportingManagerId_idx" ON "users"("organizationId", "reportingManagerId");

-- CreateIndex
CREATE INDEX "users_organizationId_employmentStatus_idx" ON "users"("organizationId", "employmentStatus");

-- AddForeignKey
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_movements" ADD CONSTRAINT "employee_movements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_movements" ADD CONSTRAINT "employee_movements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


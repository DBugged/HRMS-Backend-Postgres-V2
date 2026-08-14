-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATED', 'VERIFIED', 'APPROVED', 'LOCKED', 'PAID');

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "financialYear" TEXT,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "attendanceSummary" JSONB NOT NULL DEFAULT '{}',
    "earnings" JSONB NOT NULL DEFAULT '[]',
    "deductions" JSONB NOT NULL DEFAULT '[]',
    "employerContributions" JSONB NOT NULL DEFAULT '[]',
    "taxDetails" JSONB,
    "grossSalary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalEmployerContributions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ctcMonthly" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPayInWords" TEXT NOT NULL DEFAULT '',
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "unlockedAt" TIMESTAMP(3),
    "unlockedById" TEXT,
    "unlockReason" TEXT,
    "payslipUrl" TEXT NOT NULL DEFAULT '',
    "isFinalSettlement" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_runs_organizationId_month_year_idx" ON "payroll_runs"("organizationId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_employeeId_month_year_isFinalSettlement_key" ON "payroll_runs"("employeeId", "month", "year", "isFinalSettlement");

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_calculatedById_fkey" FOREIGN KEY ("calculatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

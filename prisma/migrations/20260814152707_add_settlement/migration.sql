-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'PROCESSED', 'PAID');

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "lastWorkingDay" TEXT NOT NULL,
    "pendingSalaryAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "leaveEncashmentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonusAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recoveriesAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loanBalanceRecovered" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "noticePeriodRecovery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gratuityAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netSettlementAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "processedById" TEXT,
    "payrollRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlements_payrollRunId_key" ON "settlements"("payrollRunId");

-- CreateIndex
CREATE INDEX "settlements_organizationId_employeeId_idx" ON "settlements"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

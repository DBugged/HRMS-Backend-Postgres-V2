-- CreateEnum
CREATE TYPE "AllocationType" AS ENUM ('FIXED_ANNUAL', 'PRORATED_ON_JOINING', 'EARNED_MONTHLY', 'UNLIMITED', 'NONE');

-- CreateEnum
CREATE TYPE "AccrualFrequency" AS ENUM ('YEARLY', 'HALF_YEARLY', 'QUARTERLY', 'MONTHLY', 'BI_MONTHLY');

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "allocationType" "AllocationType" NOT NULL DEFAULT 'FIXED_ANNUAL',
    "annualQuota" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accrualFrequency" "AccrualFrequency" NOT NULL DEFAULT 'YEARLY',
    "accrualAmountPerCycle" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prorateOnJoining" BOOLEAN NOT NULL DEFAULT true,
    "applicableDepartments" JSONB NOT NULL DEFAULT '[]',
    "applicableEmployeeTypes" JSONB NOT NULL DEFAULT '[]',
    "applicableGenders" JSONB NOT NULL DEFAULT '[]',
    "minServiceMonths" INTEGER NOT NULL DEFAULT 0,
    "maxServiceMonths" INTEGER,
    "salaryImpactPercent" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "affectsLopCalculation" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "approvalLevels" INTEGER NOT NULL DEFAULT 2,
    "autoApproveIfNoAction" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveDays" INTEGER NOT NULL DEFAULT 0,
    "rules" JSONB NOT NULL DEFAULT '{"minDurationDays":0.5,"maxDurationDays":null,"noticePeriodDays":0,"allowBackdated":false,"maxBackdateDays":0,"allowFutureDated":true,"maxAdvanceDays":null,"allowHalfDay":true,"sandwichLeaveApplies":false,"restrictPrefixSuffixHoliday":false,"maxConsecutiveDays":null,"minGapBetweenRequestsDays":0}',
    "documentsRequired" BOOLEAN NOT NULL DEFAULT false,
    "documentRequiredAfterDays" DOUBLE PRECISION,
    "carryForward" JSONB NOT NULL DEFAULT '{"allowed":false,"maxDays":0,"expiryMonths":null}',
    "negativeBalance" JSONB NOT NULL DEFAULT '{"allowed":false,"maxNegativeDays":0}',
    "encashment" JSONB NOT NULL DEFAULT '{"allowed":false,"maxDaysPerYear":0,"minBalanceToRetain":0}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "opening" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credited" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "availed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pending" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "encashed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "adjusted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carriedForwardOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carriedInExpiresOn" TEXT,
    "closing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_types_organizationId_idx" ON "leave_types"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_organizationId_name_key" ON "leave_types"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_organizationId_code_key" ON "leave_types"("organizationId", "code");

-- CreateIndex
CREATE INDEX "leave_balances_organizationId_idx" ON "leave_balances"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_organizationId_employeeId_leaveTypeId_year_key" ON "leave_balances"("organizationId", "employeeId", "leaveTypeId", "year");

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

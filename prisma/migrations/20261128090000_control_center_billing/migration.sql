-- CreateTable
CREATE TABLE "cc_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "billingModel" TEXT NOT NULL DEFAULT 'PER_EMPLOYEE',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "perEmployeeRate" DECIMAL(12,2),
    "termMonths" INTEGER,
    "basePrice" DECIMAL(12,2),
    "includedEmployees" INTEGER,
    "perExtraEmployeeRate" DECIMAL(12,2),
    "seatLimit" INTEGER,
    "gstApplicable" BOOLEAN NOT NULL DEFAULT true,
    "whiteLabelEligible" BOOLEAN NOT NULL DEFAULT false,
    "features" JSONB NOT NULL DEFAULT '[]',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "term" TEXT NOT NULL DEFAULT 'MONTHLY',
    "termMonths" INTEGER NOT NULL DEFAULT 1,
    "includedEmployeesSnap" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'TRIALING',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "dueDate" TIMESTAMP(3),
    "lineItems" JSONB NOT NULL DEFAULT '[]',
    "couponCode" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_payments" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "last4" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cc_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "currency" TEXT,
    "maxRedemptions" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "perOrgLimit" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "appliesToPlanIds" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "defaultValue" JSONB NOT NULL DEFAULT 'false',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "cc_flag_overrides" (
    "id" TEXT NOT NULL,
    "flagKey" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cc_plans_code_key" ON "cc_plans"("code");

-- CreateIndex
CREATE INDEX "cc_subscriptions_organizationId_idx" ON "cc_subscriptions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "cc_invoices_number_key" ON "cc_invoices"("number");

-- CreateIndex
CREATE INDEX "cc_invoices_organizationId_idx" ON "cc_invoices"("organizationId");

-- CreateIndex
CREATE INDEX "cc_payments_organizationId_idx" ON "cc_payments"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "cc_coupons_code_key" ON "cc_coupons"("code");

-- CreateIndex
CREATE INDEX "cc_flag_overrides_organizationId_idx" ON "cc_flag_overrides"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "cc_flag_overrides_flagKey_organizationId_key" ON "cc_flag_overrides"("flagKey", "organizationId");

-- AddForeignKey
ALTER TABLE "cc_subscriptions" ADD CONSTRAINT "cc_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_subscriptions" ADD CONSTRAINT "cc_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "cc_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_invoices" ADD CONSTRAINT "cc_invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_payments" ADD CONSTRAINT "cc_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "cc_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_payments" ADD CONSTRAINT "cc_payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_flag_overrides" ADD CONSTRAINT "cc_flag_overrides_flagKey_fkey" FOREIGN KEY ("flagKey") REFERENCES "cc_feature_flags"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_flag_overrides" ADD CONSTRAINT "cc_flag_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "attendance_regularization_requests_organizationId_employeeId_da" RENAME TO "attendance_regularization_requests_organizationId_employeeI_idx";

-- RenameIndex
ALTER INDEX "company_performance_organizationId_financialYear_departmentId_k" RENAME TO "company_performance_organizationId_financialYear_department_key";

-- RenameIndex
ALTER INDEX "leave_accrual_entries_organizationId_employeeId_leaveTypeId_per" RENAME TO "leave_accrual_entries_organizationId_employeeId_leaveTypeId_key";

-- RenameIndex
ALTER INDEX "payroll_runs_employeeId_month_year_isFinalSettlement_runSequenc" RENAME TO "payroll_runs_employeeId_month_year_isFinalSettlement_runSeq_key";

-- RenameIndex
ALTER INDEX "policy_document_acknowledgments_organizationId_policyDocu_key" RENAME TO "policy_document_acknowledgments_organizationId_policyDocume_key";


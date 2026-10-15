-- CreateTable
CREATE TABLE "employee_opening_balances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "monthsCovered" INTEGER NOT NULL,
    "taxableEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tdsDeducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pfPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ptPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_opening_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_opening_balances_organizationId_financialYear_idx" ON "employee_opening_balances"("organizationId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "employee_opening_balances_employeeId_financialYear_key" ON "employee_opening_balances"("employeeId", "financialYear");

-- AddForeignKey
ALTER TABLE "employee_opening_balances" ADD CONSTRAINT "employee_opening_balances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_opening_balances" ADD CONSTRAINT "employee_opening_balances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

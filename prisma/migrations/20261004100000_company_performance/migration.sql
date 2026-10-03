-- Company achievement % per financial year (company-wide or per department)
-- that scales variable pay, plus the supporting columns. All additive and
-- off by default: companyPerformanceEnabled=false keeps today's payroll.
CREATE TABLE "company_performance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "departmentId" TEXT,
    "achievementPercent" DOUBLE PRECISION NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_performance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "company_performance_organizationId_financialYear_departmentId_key" ON "company_performance"("organizationId", "financialYear", "departmentId");
CREATE INDEX "company_performance_organizationId_financialYear_idx" ON "company_performance"("organizationId", "financialYear");
ALTER TABLE "company_performance" ADD CONSTRAINT "company_performance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_performance" ADD CONSTRAINT "company_performance_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payroll_settings" ADD COLUMN "companyPerformanceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payroll_runs" ADD COLUMN "heldVariablePay" JSONB NOT NULL DEFAULT '[]';

-- CreateEnum
CREATE TYPE "AmountBasis" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "HeaderStyle" AS ENUM ('CLASSIC', 'MODERN', 'MINIMAL');

-- CreateEnum
CREATE TYPE "PayslipFontFamily" AS ENUM ('HELVETICA', 'TIMES_ROMAN', 'COURIER');

-- CreateTable
CREATE TABLE "employee_salary_components" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "componentCode" TEXT NOT NULL,
    "valueType" "CalcType" NOT NULL DEFAULT 'FIXED',
    "fixedAmount" DOUBLE PRECISION,
    "percentageValue" DOUBLE PRECISION,
    "percentageOf" TEXT,
    "formula" TEXT,
    "amountBasis" "AmountBasis" NOT NULL DEFAULT 'MONTHLY',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "revisionNote" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default Template',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "companyLogoUrl" TEXT,
    "companyName" TEXT NOT NULL DEFAULT 'D''Bugged Programmers',
    "companyAddress" TEXT,
    "companyEmail" TEXT,
    "companyWebsite" TEXT,
    "companyContactNumber" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#5546e0',
    "secondaryColor" TEXT NOT NULL DEFAULT '#14161d',
    "accentColor" TEXT NOT NULL DEFAULT '#10b981',
    "footerText" TEXT,
    "signatoryName" TEXT,
    "signatoryDesignation" TEXT,
    "watermarkText" TEXT,
    "headerStyle" "HeaderStyle" NOT NULL DEFAULT 'MODERN',
    "headerColor" TEXT,
    "fontFamily" "PayslipFontFamily" NOT NULL DEFAULT 'HELVETICA',
    "fontSize" INTEGER NOT NULL DEFAULT 9,
    "showCompanyAddress" BOOLEAN NOT NULL DEFAULT true,
    "showPAN" BOOLEAN NOT NULL DEFAULT true,
    "showUAN" BOOLEAN NOT NULL DEFAULT true,
    "showESIC" BOOLEAN NOT NULL DEFAULT true,
    "showPFNumber" BOOLEAN NOT NULL DEFAULT true,
    "showBankDetails" BOOLEAN NOT NULL DEFAULT true,
    "showEmployerContributions" BOOLEAN NOT NULL DEFAULT true,
    "showCTC" BOOLEAN NOT NULL DEFAULT true,
    "showYTD" BOOLEAN NOT NULL DEFAULT true,
    "showQRCode" BOOLEAN NOT NULL DEFAULT true,
    "showFooter" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_salary_components_organizationId_employeeId_compon_idx" ON "employee_salary_components"("organizationId", "employeeId", "componentCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "payroll_templates_organizationId_idx" ON "payroll_templates"("organizationId");

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_templates" ADD CONSTRAINT "payroll_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_templates" ADD CONSTRAINT "payroll_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

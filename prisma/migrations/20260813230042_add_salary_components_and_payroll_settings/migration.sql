-- CreateEnum
CREATE TYPE "SalaryComponentType" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "CalcType" AS ENUM ('FIXED', 'PERCENTAGE', 'FORMULA', 'MANUAL');

-- CreateEnum
CREATE TYPE "StatutoryKey" AS ENUM ('PF', 'ESI', 'PT', 'LWF', 'NPS', 'GRATUITY', 'BONUS', 'INCOME_TAX', 'EMPLOYER_INSURANCE');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');

-- CreateTable
CREATE TABLE "salary_components" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "SalaryComponentType" NOT NULL,
    "calcType" "CalcType" NOT NULL DEFAULT 'FIXED',
    "percentageOf" TEXT,
    "percentageValue" DOUBLE PRECISION,
    "formula" TEXT,
    "defaultValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "includeInGross" BOOLEAN NOT NULL DEFAULT true,
    "includeInNet" BOOLEAN NOT NULL DEFAULT true,
    "includeInCTC" BOOLEAN NOT NULL DEFAULT true,
    "isEmployerContribution" BOOLEAN NOT NULL DEFAULT false,
    "showOnPayslip" BOOLEAN NOT NULL DEFAULT true,
    "isStatutory" BOOLEAN NOT NULL DEFAULT false,
    "statutoryKey" "StatutoryKey",
    "payFrequency" "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialYearStartMonth" INTEGER NOT NULL DEFAULT 4,
    "processingDay" INTEGER NOT NULL DEFAULT 0,
    "paymentDay" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "currencySymbol" TEXT NOT NULL DEFAULT '₹',
    "roundingRule" TEXT NOT NULL DEFAULT 'nearest',
    "roundingDecimals" INTEGER NOT NULL DEFAULT 0,
    "pfEnabled" BOOLEAN NOT NULL DEFAULT false,
    "esiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ptEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lwfEnabled" BOOLEAN NOT NULL DEFAULT false,
    "npsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gratuityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bonusEnabled" BOOLEAN NOT NULL DEFAULT false,
    "incomeTaxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "employerInsuranceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pfEmployeeRate" DOUBLE PRECISION NOT NULL DEFAULT 12,
    "pfEmployerRate" DOUBLE PRECISION NOT NULL DEFAULT 12,
    "pfWageCeiling" DOUBLE PRECISION NOT NULL DEFAULT 15000,
    "esiEmployeeRate" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "esiEmployerRate" DOUBLE PRECISION NOT NULL DEFAULT 3.25,
    "esiWageCeiling" DOUBLE PRECISION NOT NULL DEFAULT 21000,
    "ptSlabs" JSONB NOT NULL DEFAULT '[{"upTo":7500,"amount":0},{"upTo":10000,"amount":175},{"upTo":null,"amount":200}]',
    "lwfEmployeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "lwfEmployerAmount" DOUBLE PRECISION NOT NULL DEFAULT 75,
    "npsEmployerRate" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "gratuityRate" DOUBLE PRECISION NOT NULL DEFAULT 4.81,
    "compOffExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_components_organizationId_idx" ON "salary_components"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_organizationId_code_key" ON "salary_components"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_settings_organizationId_key" ON "payroll_settings"("organizationId");

-- AddForeignKey
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

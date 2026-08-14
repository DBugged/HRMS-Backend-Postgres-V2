-- CreateEnum
CREATE TYPE "StatutoryModule" AS ENUM ('PF', 'ESI', 'PT', 'LWF', 'GRATUITY', 'BONUS', 'NPS', 'PAYROLL_CALENDAR', 'ROUNDING');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('OLD', 'NEW');

-- CreateEnum
CREATE TYPE "TaxDeclarationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VERIFIED');

-- CreateTable
CREATE TABLE "statutory_config_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "module" "StatutoryModule" NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "statutory_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tax_declarations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "regimeChosen" "TaxRegime" NOT NULL DEFAULT 'NEW',
    "section80C" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section80CCD1B" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section80CCD2" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section80D" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section80E" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section80G" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hraRentPaidAnnual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isMetroCity" BOOLEAN NOT NULL DEFAULT false,
    "ltaClaimed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "previousEmployerIncome" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "previousEmployerTDS" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherIncome" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "TaxDeclarationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_tax_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_slab_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "regime" "TaxRegime" NOT NULL,
    "slabs" JSONB NOT NULL DEFAULT '[]',
    "standardDeduction" DOUBLE PRECISION NOT NULL DEFAULT 75000,
    "cessRate" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "surchargeSlabs" JSONB NOT NULL DEFAULT '[]',
    "rebate87ALimit" DOUBLE PRECISION NOT NULL DEFAULT 1200000,
    "rebate87AAmount" DOUBLE PRECISION NOT NULL DEFAULT 60000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_slab_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statutory_config_versions_organizationId_module_effectiveFr_idx" ON "statutory_config_versions"("organizationId", "module", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_tax_declarations_organizationId_idx" ON "employee_tax_declarations"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_tax_declarations_organizationId_employeeId_financi_key" ON "employee_tax_declarations"("organizationId", "employeeId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "tax_slab_configs_organizationId_financialYear_regime_key" ON "tax_slab_configs"("organizationId", "financialYear", "regime");

-- AddForeignKey
ALTER TABLE "statutory_config_versions" ADD CONSTRAINT "statutory_config_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statutory_config_versions" ADD CONSTRAINT "statutory_config_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declarations" ADD CONSTRAINT "employee_tax_declarations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tax_declarations" ADD CONSTRAINT "employee_tax_declarations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_slab_configs" ADD CONSTRAINT "tax_slab_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Asset Inventory module (additive only): 4 new enums, 2 new enum values on
-- existing enums, 3 new tables, and 1 new nullable column on employee_assets.
-- Nothing existing is altered or dropped.

-- New enum values on existing enums.
ALTER TYPE "OrgListType" ADD VALUE IF NOT EXISTS 'ASSET_CATEGORY';
ALTER TYPE "AuditModule" ADD VALUE IF NOT EXISTS 'ASSET';

-- New enums.
CREATE TYPE "AssetInventoryStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'UNDER_MAINTENANCE', 'LOST', 'RETIRED', 'DISPOSED');
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED');
CREATE TYPE "AssetDocType" AS ENUM ('INVOICE', 'WARRANTY_CERTIFICATE', 'AMC', 'SERVICE_REPORT', 'OTHER');
CREATE TYPE "AssetMaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- Master inventory record.
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "categoryId" TEXT,
    "categorySpecify" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "assetTag" TEXT,
    "serialNumber" TEXT,
    "purchasedFrom" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" DOUBLE PRECISION,
    "vendorContact" TEXT,
    "invoiceNumber" TEXT,
    "poNumber" TEXT,
    "location" TEXT,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetInventoryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "usefulLifeMonths" INTEGER,
    "remarks" TEXT,
    "warrantyProvider" TEXT,
    "warrantyNumber" TEXT,
    "warrantyStartDate" TIMESTAMP(3),
    "warrantyEndDate" TIMESTAMP(3),
    "warrantyPeriodMonths" INTEGER,
    "supportContact" TEXT,
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "warrantyTerms" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "asset_maintenances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "issue" TEXT NOT NULL,
    "serviceProvider" TEXT,
    "serviceCost" DOUBLE PRECISION,
    "serviceStatus" "AssetMaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "serviceStartDate" TIMESTAMP(3),
    "serviceCompletionDate" TIMESTAMP(3),
    "nextServiceDate" TIMESTAMP(3),
    "warrantyClaim" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_maintenances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "asset_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "maintenanceId" TEXT,
    "docType" "AssetDocType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assets_organizationId_assetCode_key" ON "assets"("organizationId", "assetCode");
CREATE UNIQUE INDEX "assets_organizationId_assetTag_key" ON "assets"("organizationId", "assetTag");
CREATE UNIQUE INDEX "assets_organizationId_serialNumber_key" ON "assets"("organizationId", "serialNumber");
CREATE INDEX "assets_organizationId_status_idx" ON "assets"("organizationId", "status");
CREATE INDEX "assets_organizationId_categoryId_idx" ON "assets"("organizationId", "categoryId");
CREATE INDEX "asset_maintenances_organizationId_assetId_idx" ON "asset_maintenances"("organizationId", "assetId");
CREATE INDEX "asset_documents_organizationId_assetId_idx" ON "asset_documents"("organizationId", "assetId");

ALTER TABLE "assets" ADD CONSTRAINT "assets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "org_list_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "asset_maintenances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Links an allocation event to its inventory master record. Nullable: every
-- existing row stays valid at NULL and the free-text allocate flow is
-- unchanged when the field is omitted.
ALTER TABLE "employee_assets" ADD COLUMN "assetId" TEXT;
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "employee_assets_assetId_idx" ON "employee_assets"("assetId");

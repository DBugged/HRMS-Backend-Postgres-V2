-- AlterTable
ALTER TABLE "users" ADD COLUMN "brandId" TEXT;

-- CreateTable
CREATE TABLE "company_brands" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "logoUrl" TEXT,
    "emailLogoUrl" TEXT,
    "address" TEXT,
    "contactEmail" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "employeeIdFormat" TEXT,
    "employeeIdCounter" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_brands_organizationId_name_key" ON "company_brands"("organizationId", "name");

-- CreateIndex
CREATE INDEX "company_brands_organizationId_idx" ON "company_brands"("organizationId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "company_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_brands" ADD CONSTRAINT "company_brands_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

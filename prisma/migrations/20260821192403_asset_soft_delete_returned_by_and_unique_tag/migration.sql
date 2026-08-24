/*
  Warnings:

  - A unique constraint covering the columns `[organizationId,assetTag]` on the table `employee_assets` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "employee_assets" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "returnedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "employee_assets_organizationId_assetTag_key" ON "employee_assets"("organizationId", "assetTag");

-- AddForeignKey
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

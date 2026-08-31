-- CreateEnum
CREATE TYPE "OrgListType" AS ENUM ('DESIGNATION', 'GRADE', 'EMPLOYEE_CATEGORY');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employeeCategory" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "gradeLevel" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "org_list_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "OrgListType" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_list_items_organizationId_type_idx" ON "org_list_items"("organizationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "org_list_items_organizationId_type_name_key" ON "org_list_items"("organizationId", "type", "name");

-- AddForeignKey
ALTER TABLE "org_list_items" ADD CONSTRAINT "org_list_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

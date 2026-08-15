-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "ProbationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXTENDED');

-- CreateEnum
CREATE TYPE "EmployeeDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ALLOCATED', 'RETURNED', 'LOST');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "gender" "Gender",
ADD COLUMN     "personalData" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "probationEndDate" TEXT,
ADD COLUMN     "probationStatus" "ProbationStatus",
ADD COLUMN     "profileImage" TEXT;

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "status" "EmployeeDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_assets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "assetTag" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'ALLOCATED',
    "allocatedDate" TEXT NOT NULL,
    "returnedDate" TEXT,
    "notes" TEXT,
    "allocatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_role_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "previousRole" "Role",
    "newRole" "Role",
    "previousDesignation" TEXT,
    "newDesignation" TEXT,
    "previousDepartmentId" TEXT,
    "newDepartmentId" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_role_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_status_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "previousStatus" "EmploymentStatus",
    "newStatus" "EmploymentStatus" NOT NULL,
    "note" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_documents_organizationId_employeeId_idx" ON "employee_documents"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "employee_assets_organizationId_employeeId_idx" ON "employee_assets"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "employee_role_history_organizationId_employeeId_idx" ON "employee_role_history"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "employment_status_history_organizationId_employeeId_idx" ON "employment_status_history"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_allocatedById_fkey" FOREIGN KEY ("allocatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_role_history" ADD CONSTRAINT "employee_role_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_role_history" ADD CONSTRAINT "employee_role_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_role_history" ADD CONSTRAINT "employee_role_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_status_history" ADD CONSTRAINT "employment_status_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_status_history" ADD CONSTRAINT "employment_status_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_status_history" ADD CONSTRAINT "employment_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "PolicyDocType" AS ENUM ('PDF', 'IMAGE', 'VIDEO', 'URL');

-- CreateEnum
CREATE TYPE "PolicyVisibility" AS ENUM ('EVERYONE', 'HR_ONLY', 'MANAGERS', 'DEPARTMENTS', 'EMPLOYEES');

-- CreateTable
CREATE TABLE "policy_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "docType" "PolicyDocType" NOT NULL DEFAULT 'PDF',
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "uploadedById" TEXT,
    "visibility" "PolicyVisibility" NOT NULL DEFAULT 'EVERYONE',
    "visibleDepartments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibleEmployees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_requirements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_documents_organizationId_createdAt_idx" ON "policy_documents"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "document_requirements_organizationId_name_key" ON "document_requirements"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

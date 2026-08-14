-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING_VALIDATION', 'VALIDATED', 'REJECTED', 'EXECUTED');

-- CreateTable
CREATE TABLE "attendance_import_batches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "departmentId" TEXT,
    "fileName" TEXT NOT NULL DEFAULT '',
    "rows" JSONB NOT NULL DEFAULT '[]',
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING_VALIDATION',
    "validationErrors" JSONB NOT NULL DEFAULT '[]',
    "validatedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "executionResult" JSONB NOT NULL DEFAULT '{"imported":0,"skipped":0,"errors":0}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_import_batches_organizationId_idx" ON "attendance_import_batches"("organizationId");

-- AddForeignKey
ALTER TABLE "attendance_import_batches" ADD CONSTRAINT "attendance_import_batches_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_import_batches" ADD CONSTRAINT "attendance_import_batches_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_import_batches" ADD CONSTRAINT "attendance_import_batches_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_import_batches" ADD CONSTRAINT "attendance_import_batches_validatedById_fkey" FOREIGN KEY ("validatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_import_batches" ADD CONSTRAINT "attendance_import_batches_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

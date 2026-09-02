-- CreateEnum
CREATE TYPE "EmployeeDocumentCategory" AS ENUM ('DOCUMENT', 'LETTER');

-- AlterTable
ALTER TABLE "employee_documents" ADD COLUMN     "category" "EmployeeDocumentCategory" NOT NULL DEFAULT 'DOCUMENT';

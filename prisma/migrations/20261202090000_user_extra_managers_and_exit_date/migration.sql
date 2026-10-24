-- AlterTable
ALTER TABLE "users" ADD COLUMN     "additionalReportingManagerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "exitDate" TEXT;


-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "inactiveBuiltinEmployeeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

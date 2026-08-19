-- CreateEnum
CREATE TYPE "WfhApprovalStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "attendances" ADD COLUMN     "workArrangementReviewComments" TEXT,
ADD COLUMN     "workArrangementReviewedAt" TIMESTAMP(3),
ADD COLUMN     "workArrangementReviewedById" TEXT,
ADD COLUMN     "workArrangementStatus" "WfhApprovalStatus" NOT NULL DEFAULT 'NONE';

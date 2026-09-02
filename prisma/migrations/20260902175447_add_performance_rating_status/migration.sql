-- CreateEnum
CREATE TYPE "PerformanceRatingStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "performance_ratings" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "status" "PerformanceRatingStatus" NOT NULL DEFAULT 'SUBMITTED';

-- AddForeignKey
ALTER TABLE "performance_ratings" ADD CONSTRAINT "performance_ratings_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: pre-existing rows were already effectively "published" under the
-- old upsert-only flow (no draft/approval concept existed), so they should
-- not be stuck as SUBMITTED under the new default.
UPDATE "performance_ratings" SET "status" = 'APPROVED' WHERE "createdAt" < now();

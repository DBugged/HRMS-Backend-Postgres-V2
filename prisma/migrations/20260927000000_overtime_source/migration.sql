-- CreateEnum
CREATE TYPE "OvertimeSource" AS ENUM ('SELF', 'AUTO_PUNCH');

-- AlterTable
ALTER TABLE "overtime_records" ADD COLUMN "source" "OvertimeSource" NOT NULL DEFAULT 'SELF';

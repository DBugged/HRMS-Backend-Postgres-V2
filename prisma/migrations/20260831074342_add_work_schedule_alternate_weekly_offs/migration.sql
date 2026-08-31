-- AlterTable
ALTER TABLE "work_schedules" ADD COLUMN     "alternateWeeklyOffs" JSONB NOT NULL DEFAULT '[]';

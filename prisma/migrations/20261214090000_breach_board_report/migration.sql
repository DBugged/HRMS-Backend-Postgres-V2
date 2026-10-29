-- AlterTable
ALTER TABLE "breach_incidents" ADD COLUMN     "boardReportedAt" TIMESTAMP(3),
ADD COLUMN     "principalsNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "dueSoonRemindedAt" TIMESTAMP(3),
ADD COLUMN     "overdueRemindedAt" TIMESTAMP(3);

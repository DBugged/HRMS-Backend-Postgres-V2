-- Nothing ever sent an ONBOARDING-category notification. Fold any stray rows into GENERAL, then drop the value from the enum.
UPDATE "notifications" SET "category" = 'GENERAL' WHERE "category" = 'ONBOARDING';

ALTER TYPE "NotificationCategory" RENAME TO "NotificationCategory_old";
CREATE TYPE "NotificationCategory" AS ENUM ('LEAVE', 'REGULARIZATION', 'PAYROLL', 'ATTENDANCE', 'GENERAL');
ALTER TABLE "notifications" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "notifications" ALTER COLUMN "category" TYPE "NotificationCategory" USING ("category"::text::"NotificationCategory");
ALTER TABLE "notifications" ALTER COLUMN "category" SET DEFAULT 'GENERAL';
DROP TYPE "NotificationCategory_old";

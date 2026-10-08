-- AlterTable
ALTER TABLE "push_devices"
  ADD COLUMN "appVersion" TEXT,
  ADD COLUMN "buildNumber" TEXT,
  ADD COLUMN "deviceType" TEXT,
  ADD COLUMN "deviceModel" TEXT,
  ADD COLUMN "os" TEXT,
  ADD COLUMN "osVersion" TEXT;

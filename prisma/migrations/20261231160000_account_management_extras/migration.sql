-- Account Management extras: monthly scheduled exports and the Account Activity tab switch.
CREATE TABLE "cc_export_schedules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'XLSX',
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cc_export_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cc_export_schedules_organizationId_category_key" ON "cc_export_schedules"("organizationId", "category");
ALTER TABLE "cc_export_schedules" ADD CONSTRAINT "cc_export_schedules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "cc_feature_flags" ("key", "description", "defaultValue", "status", "updatedAt")
VALUES ('module.account_activity', 'Account Management: Account Activity', 'true', 'ACTIVE', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

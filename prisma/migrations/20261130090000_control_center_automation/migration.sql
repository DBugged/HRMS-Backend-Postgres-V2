-- AlterTable
ALTER TABLE "cc_invoices" ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "periodMonths" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "cc_subscriptions" ADD COLUMN     "customPerEmployeeRate" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "cc_org_profiles" (
    "organizationId" TEXT NOT NULL,
    "accountManager" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "churnReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_org_profiles_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "cc_alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "organizationId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cc_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cc_alerts_dedupeKey_key" ON "cc_alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "cc_alerts_createdAt_idx" ON "cc_alerts"("createdAt");

-- AddForeignKey
ALTER TABLE "cc_org_profiles" ADD CONSTRAINT "cc_org_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_alerts" ADD CONSTRAINT "cc_alerts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Billing automation settings (all OFF by default: nothing is invoiced or switched off until a Super Admin turns it on).
INSERT INTO "cc_settings" ("key","value","type","restricted","description","updatedAt") VALUES
('billing.auto_invoice','false','bool',false,'Create invoices automatically when a pilot ends and before each renewal.',now()),
('billing.auto_suspend_days','0','number',false,'Switch a company off this many days after an invoice is overdue. 0 = never.',now()),
('billing.reminder_days','3','number',false,'Email the company this many days before an invoice is due (and when overdue).',now()),
('billing.email_customers','false','bool',false,'Let the automation email invoices and reminders to the company''s billing email.',now())
ON CONFLICT ("key") DO NOTHING;

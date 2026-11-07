-- Account Management (Company Admin): storage allowance, ticket category/attachments, requests to the Super Admin, export history,
-- and the five tab switches (one module flag each, on by default; a Super Admin turns one off per company under Features).
ALTER TABLE "cc_subscriptions" ADD COLUMN "maxStorageMb" INTEGER;

ALTER TABLE "cc_tickets" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "cc_tickets" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "cc_ticket_comments" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "cc_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cc_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cc_requests_organizationId_idx" ON "cc_requests"("organizationId");
CREATE INDEX "cc_requests_status_idx" ON "cc_requests"("status");
ALTER TABLE "cc_requests" ADD CONSTRAINT "cc_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cc_exports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "fileKey" TEXT,
    "fileName" TEXT,
    "rowCount" INTEGER,
    "error" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cc_exports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cc_exports_organizationId_createdAt_idx" ON "cc_exports"("organizationId", "createdAt");
ALTER TABLE "cc_exports" ADD CONSTRAINT "cc_exports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "cc_feature_flags" ("key","description","defaultValue","status","updatedAt") VALUES
('module.account_billing','Account Management: Subscription & Billing','true','ACTIVE',now()),
('module.account_plan','Account Management: My Plan & Modules','true','ACTIVE',now()),
('module.account_usage','Account Management: Usage & Limits','true','ACTIVE',now()),
('module.account_export','Account Management: Data Export','true','ACTIVE',now()),
('module.account_support','Account Management: Support & Tickets','true','ACTIVE',now())
ON CONFLICT ("key") DO NOTHING;

-- CreateTable
CREATE TABLE "cc_tickets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "assigneeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_ticket_comments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "organizationId" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cc_ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "audienceRef" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT '',
    "entityId" TEXT NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "context" JSONB,
    "requestId" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "cc_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cc_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'string',
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cc_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "cc_tickets_organizationId_idx" ON "cc_tickets"("organizationId");

-- CreateIndex
CREATE INDEX "cc_ticket_comments_ticketId_idx" ON "cc_ticket_comments"("ticketId");

-- CreateIndex
CREATE INDEX "cc_audit_log_at_idx" ON "cc_audit_log"("at");

-- CreateIndex
CREATE INDEX "cc_audit_log_actorId_idx" ON "cc_audit_log"("actorId");

-- AddForeignKey
ALTER TABLE "cc_tickets" ADD CONSTRAINT "cc_tickets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cc_ticket_comments" ADD CONSTRAINT "cc_ticket_comments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "cc_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Starting platform settings. Idempotent.
INSERT INTO "cc_settings" ("key","value","type","restricted","description","updatedAt") VALUES
('billing.gst_rate','18','number',false,'GST percentage added to invoices.',now()),
('billing.invoice_due_days','7','number',false,'Days from creation until an invoice is due.',now()),
('billing.currency','"INR"','string',true,'Currency for plans and invoices.',now()),
('platform.default_trial_days','60','number',false,'Pilot length for a new subscription when the plan does not set one.',now()),
('platform.maintenance_mode','false','bool',false,'Show a maintenance notice to customers (not enforced by the HRMS app yet).',now()),
('support.email','"support@dbuggedprogrammers.com"','string',false,'Where customers are told to write for support.',now())
ON CONFLICT ("key") DO NOTHING;

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DataRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'UPDATE', 'EXPORT', 'ERASURE');

-- CreateEnum
CREATE TYPE "DataRequestStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DpaStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SIGNED');

-- CreateEnum
CREATE TYPE "PrivacyRecordStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PrivacyNoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "BreachSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BreachContainmentStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'CONTAINED');

-- CreateEnum
CREATE TYPE "BreachNotificationStatus" AS ENUM ('NOT_ASSESSED', 'NOT_REQUIRED', 'PENDING', 'NOTIFIED');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "privacy_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "privacyOfficerName" TEXT NOT NULL DEFAULT '',
    "privacyOfficerEmail" TEXT NOT NULL DEFAULT '',
    "privacyOfficerPhone" TEXT NOT NULL DEFAULT '',
    "grievanceInfo" TEXT NOT NULL DEFAULT '',
    "requestSlaDays" INTEGER NOT NULL DEFAULT 30,
    "processingPurposes" JSONB NOT NULL DEFAULT '[]',
    "dataCategories" JSONB NOT NULL DEFAULT '[]',
    "retentionRules" JSONB NOT NULL DEFAULT '[]',
    "exportSettings" JSONB NOT NULL DEFAULT '{}',
    "deletionRules" JSONB NOT NULL DEFAULT '{}',
    "processorsSeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_notice_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PrivacyNoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_notice_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purposeKey" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "noticeVersionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SELF_SERVICE',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL,
    "requestNo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "DataRequestType" NOT NULL,
    "status" "DataRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "assignedToId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "exportFileKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_processors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "dataProcessed" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL DEFAULT '',
    "dpaStatus" "DpaStatus" NOT NULL DEFAULT 'PENDING',
    "status" "PrivacyRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSystemDetected" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_processors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sharing_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "dataCategory" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "integration" TEXT NOT NULL DEFAULT '',
    "status" "PrivacyRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "isAutoRecorded" BOOLEAN NOT NULL DEFAULT false,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_sharing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_incidents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL,
    "incidentNo" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "reportedBy" TEXT NOT NULL DEFAULT '',
    "affectedSystem" TEXT NOT NULL DEFAULT '',
    "dataCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "affectedUsersCount" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "severity" "BreachSeverity" NOT NULL DEFAULT 'MEDIUM',
    "containmentStatus" "BreachContainmentStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "investigation" TEXT NOT NULL DEFAULT '',
    "actionsTaken" TEXT NOT NULL DEFAULT '',
    "notificationStatus" "BreachNotificationStatus" NOT NULL DEFAULT 'NOT_ASSESSED',
    "resolution" TEXT NOT NULL DEFAULT '',
    "status" "BreachStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breach_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "targetUserId" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "result" TEXT NOT NULL DEFAULT 'SUCCESS',
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "prevHash" TEXT NOT NULL DEFAULT '',
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_settings_organizationId_key" ON "privacy_settings"("organizationId");

-- CreateIndex
CREATE INDEX "privacy_notice_versions_organizationId_status_idx" ON "privacy_notice_versions"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_notice_versions_organizationId_version_key" ON "privacy_notice_versions"("organizationId", "version");

-- CreateIndex
CREATE INDEX "consent_records_organizationId_userId_purposeKey_at_idx" ON "consent_records"("organizationId", "userId", "purposeKey", "at");

-- CreateIndex
CREATE INDEX "data_requests_organizationId_userId_idx" ON "data_requests"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "data_requests_organizationId_status_idx" ON "data_requests"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "data_requests_organizationId_seqNo_key" ON "data_requests"("organizationId", "seqNo");

-- CreateIndex
CREATE INDEX "data_processors_organizationId_idx" ON "data_processors"("organizationId");

-- CreateIndex
CREATE INDEX "data_sharing_records_organizationId_sharedAt_idx" ON "data_sharing_records"("organizationId", "sharedAt");

-- CreateIndex
CREATE INDEX "breach_incidents_organizationId_status_idx" ON "breach_incidents"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "breach_incidents_organizationId_seqNo_key" ON "breach_incidents"("organizationId", "seqNo");

-- CreateIndex
CREATE INDEX "privacy_audit_logs_organizationId_seq_idx" ON "privacy_audit_logs"("organizationId", "seq");

-- CreateIndex
CREATE INDEX "privacy_audit_logs_organizationId_category_createdAt_idx" ON "privacy_audit_logs"("organizationId", "category", "createdAt");

-- CreateIndex
CREATE INDEX "privacy_audit_logs_organizationId_targetUserId_idx" ON "privacy_audit_logs"("organizationId", "targetUserId");

-- AddForeignKey
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_notice_versions" ADD CONSTRAINT "privacy_notice_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_processors" ADD CONSTRAINT "data_processors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sharing_records" ADD CONSTRAINT "data_sharing_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_incidents" ADD CONSTRAINT "breach_incidents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_audit_logs" ADD CONSTRAINT "privacy_audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


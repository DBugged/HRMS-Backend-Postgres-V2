-- Full & Final settlement controls: notice pay/recovery, recovery reason, leave-encashment exemption and detail,
-- closed-loan snapshot, maker/payment/reversal stamps.
ALTER TABLE "settlements"
  ADD COLUMN "noticePayAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "noticeShortfallDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "noticeRecoveryAuto" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recoveriesReason" TEXT,
  ADD COLUMN "leaveEncashmentExempt" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "leaveEncashmentDetail" JSONB,
  ADD COLUMN "closedLoans" JSONB,
  ADD COLUMN "loanBalanceUnrecovered" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "calculatedById" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidById" TEXT,
  ADD COLUMN "paymentMode" TEXT,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;

-- One open draft per employee: two concurrent calculations can no longer leave two drafts behind.
-- Duplicate drafts (never paid anything) keep only the newest; a case pointing at an older one is unlinked first.
CREATE TEMP TABLE "_dup_drafts" AS
SELECT a."id" FROM "settlements" a JOIN "settlements" b
  ON a."status" = 'DRAFT' AND b."status" = 'DRAFT'
 AND a."organizationId" = b."organizationId" AND a."employeeId" = b."employeeId"
 AND (a."createdAt" < b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));
UPDATE "offboarding_cases" SET "settlementId" = NULL WHERE "settlementId" IN (SELECT "id" FROM "_dup_drafts");
DELETE FROM "settlements" WHERE "id" IN (SELECT "id" FROM "_dup_drafts");
DROP TABLE "_dup_drafts";
CREATE UNIQUE INDEX "settlements_one_draft_per_employee"
  ON "settlements" ("organizationId", "employeeId") WHERE "status" = 'DRAFT';

-- An employee's request to withdraw an approved resignation now has a state HR can act on.
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED');

ALTER TABLE "resignations"
  ADD COLUMN "withdrawalStatus" "WithdrawalRequestStatus",
  ADD COLUMN "withdrawalReason" TEXT,
  ADD COLUMN "withdrawalRequestedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalDecidedById" TEXT,
  ADD COLUMN "withdrawalDecidedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalDecisionNote" TEXT;

CREATE INDEX "resignations_organizationId_withdrawalStatus_idx" ON "resignations"("organizationId", "withdrawalStatus");

-- An employee can ask to cancel an approved leave that has already started; an approver then decides it.
ALTER TABLE "leaves"
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "cancelRequestDeclinedComments" TEXT NOT NULL DEFAULT '';

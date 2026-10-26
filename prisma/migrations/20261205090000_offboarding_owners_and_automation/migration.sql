-- Exit checklist owners / due dates, the items the system ticked by itself, and the automation markers on an offboarding case.
ALTER TABLE "offboarding_cases"
  ADD COLUMN "checklistMeta" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "autoTicked" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "fnfPreparedAt" TIMESTAMP(3),
  ADD COLUMN "readyToCompleteAt" TIMESTAMP(3),
  ADD COLUMN "lettersSentAt" TIMESTAMP(3);

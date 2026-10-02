-- Per-document opt-in: only compliance policies (Code of Conduct, POSH, IT
-- Acceptable Use, ...) need an employee e-acknowledgment; informational docs
-- (holiday list, handbook) are view/download only. Off by default, including
-- for existing documents — existing acknowledgment rows are kept untouched and
-- reappear if HR turns the flag back on.
ALTER TABLE "policy_documents" ADD COLUMN "requiresAcknowledgment" BOOLEAN NOT NULL DEFAULT false;

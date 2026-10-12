-- Accountability fields on the audit trail: the actor's role at the time, whether the action succeeded or was refused, and
-- the request it belongs to. Additive; existing rows read as SUCCESS with no role or request id.
ALTER TABLE "audit_logs" ADD COLUMN "actorRole" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'SUCCESS';
ALTER TABLE "audit_logs" ADD COLUMN "requestId" TEXT;

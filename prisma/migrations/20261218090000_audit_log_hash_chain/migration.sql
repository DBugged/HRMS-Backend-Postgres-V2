-- Tamper-evident audit trail: a per-row sequence plus the previous row's hash and this row's hash.
ALTER TABLE "audit_logs" ADD COLUMN "seq" SERIAL;
ALTER TABLE "audit_logs" ADD COLUMN "prevHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "audit_logs" ADD COLUMN "hash" TEXT NOT NULL DEFAULT '';
CREATE INDEX "audit_logs_organizationId_seq_idx" ON "audit_logs"("organizationId", "seq");

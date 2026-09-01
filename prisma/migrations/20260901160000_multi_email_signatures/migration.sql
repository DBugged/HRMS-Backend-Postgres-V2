ALTER TABLE "organizations" ADD COLUMN "emailSignatures" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "email_templates" ADD COLUMN "signatureId" TEXT;

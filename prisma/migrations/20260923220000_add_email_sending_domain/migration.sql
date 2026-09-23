-- Additive only: custom per-org email sending domain (Resend domain verification).
ALTER TABLE "organizations" ADD COLUMN "emailSendingAddress" TEXT;
ALTER TABLE "organizations" ADD COLUMN "resendDomainId" TEXT;
ALTER TABLE "organizations" ADD COLUMN "emailDomainStatus" TEXT NOT NULL DEFAULT 'not_started';

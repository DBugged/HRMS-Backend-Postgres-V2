-- Replaces Resend-domain verification with a self-hosted DNS TXT record check.
ALTER TABLE "organizations" RENAME COLUMN "resendDomainId" TO "emailDomainVerificationToken";
UPDATE "organizations" SET "emailDomainVerificationToken" = NULL, "emailDomainStatus" = 'not_started' WHERE "emailDomainStatus" != 'not_started';

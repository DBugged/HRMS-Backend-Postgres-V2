-- Access tokens issued before a password change/reset are rejected from then on.
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

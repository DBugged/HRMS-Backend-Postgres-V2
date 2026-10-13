-- Self-registered founders must confirm their e-mail address before signing in.
ALTER TABLE "users"
  ADD COLUMN "emailVerificationToken" TEXT,
  ADD COLUMN "emailVerificationExpires" TIMESTAMP(3);
CREATE UNIQUE INDEX "users_emailVerificationToken_key" ON "users"("emailVerificationToken");

ALTER TABLE "refresh_tokens" ADD COLUMN "sessionId" TEXT;
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_sessions_userId_clientType_endedAt_idx" ON "auth_sessions"("userId", "clientType", "endedAt");
CREATE INDEX "auth_sessions_organizationId_idx" ON "auth_sessions"("organizationId");

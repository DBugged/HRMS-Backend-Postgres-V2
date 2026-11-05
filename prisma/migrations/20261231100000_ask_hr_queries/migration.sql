CREATE TABLE "ask_hr_queries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answered" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_hr_queries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ask_hr_queries_organizationId_createdAt_idx" ON "ask_hr_queries"("organizationId", "createdAt");

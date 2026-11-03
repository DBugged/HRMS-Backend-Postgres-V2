-- Which statutory returns / payments HR has confirmed as filed (the filing tracker).
CREATE TABLE "statutory_filings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filedById" TEXT NOT NULL,

    CONSTRAINT "statutory_filings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "statutory_filings_organizationId_key_dueDate_key" ON "statutory_filings"("organizationId", "key", "dueDate");
CREATE INDEX "statutory_filings_organizationId_idx" ON "statutory_filings"("organizationId");

ALTER TABLE "statutory_filings" ADD CONSTRAINT "statutory_filings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

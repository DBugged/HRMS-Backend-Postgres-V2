-- TDS compliance: challan deposits and quarterly statement receipts (monthly/quarterly TDS return, Form 130).
CREATE TABLE "tds_challans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "financialYear" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "bsrCode" TEXT NOT NULL,
    "challanSerialNo" TEXT NOT NULL,
    "depositDate" TEXT NOT NULL,
    "tdsAmount" DOUBLE PRECISION NOT NULL,
    "interest" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tds_challans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tds_challans_organizationId_financialYear_quarter_idx" ON "tds_challans"("organizationId", "financialYear", "quarter");
CREATE INDEX "tds_challans_organizationId_year_month_idx" ON "tds_challans"("organizationId", "year", "month");
ALTER TABLE "tds_challans" ADD CONSTRAINT "tds_challans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "tds_statements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "formType" TEXT NOT NULL DEFAULT '138',
    "receiptNumber" TEXT NOT NULL,
    "filedOn" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tds_statements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tds_statements_organizationId_financialYear_quarter_key" ON "tds_statements"("organizationId", "financialYear", "quarter");
ALTER TABLE "tds_statements" ADD CONSTRAINT "tds_statements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "policy_document_acknowledgments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "policyDocumentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "signatureName" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_document_acknowledgments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_document_acknowledgments_organizationId_employeeId_idx" ON "policy_document_acknowledgments"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "policy_document_acknowledgments_organizationId_policyDocu_key" ON "policy_document_acknowledgments"("organizationId", "policyDocumentId", "employeeId");

-- AddForeignKey
ALTER TABLE "policy_document_acknowledgments" ADD CONSTRAINT "policy_document_acknowledgments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_document_acknowledgments" ADD CONSTRAINT "policy_document_acknowledgments_policyDocumentId_fkey" FOREIGN KEY ("policyDocumentId") REFERENCES "policy_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_document_acknowledgments" ADD CONSTRAINT "policy_document_acknowledgments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

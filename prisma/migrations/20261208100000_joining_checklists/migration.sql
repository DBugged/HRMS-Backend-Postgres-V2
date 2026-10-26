-- CreateTable
CREATE TABLE "joining_checklists" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "joining_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "joining_checklists_organizationId_employeeId_key" ON "joining_checklists"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "joining_checklists_organizationId_idx" ON "joining_checklists"("organizationId");

-- AddForeignKey
ALTER TABLE "joining_checklists" ADD CONSTRAINT "joining_checklists_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "joining_checklists" ADD CONSTRAINT "joining_checklists_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

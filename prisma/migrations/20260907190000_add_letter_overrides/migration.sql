-- CreateTable
CREATE TABLE "letter_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "letter_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "letter_overrides_organizationId_employeeId_idx" ON "letter_overrides"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "letter_overrides_organizationId_employeeId_key_key" ON "letter_overrides"("organizationId", "employeeId", "key");

-- AddForeignKey
ALTER TABLE "letter_overrides" ADD CONSTRAINT "letter_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_overrides" ADD CONSTRAINT "letter_overrides_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_overrides" ADD CONSTRAINT "letter_overrides_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

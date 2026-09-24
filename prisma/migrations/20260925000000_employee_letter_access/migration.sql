-- CreateTable
CREATE TABLE "employee_letter_access" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_letter_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_letter_access_organizationId_employeeId_idx" ON "employee_letter_access"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_letter_access_organizationId_employeeId_key_key" ON "employee_letter_access"("organizationId", "employeeId", "key");

-- AddForeignKey
ALTER TABLE "employee_letter_access" ADD CONSTRAINT "employee_letter_access_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_letter_access" ADD CONSTRAINT "employee_letter_access_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_letter_access" ADD CONSTRAINT "employee_letter_access_enabledById_fkey" FOREIGN KEY ("enabledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "AuditModule" AS ENUM ('AUTH', 'EMPLOYEE', 'ATTENDANCE', 'LEAVE', 'PAYROLL', 'DEPARTMENT', 'DOCUMENT', 'HOLIDAY', 'NOTIFICATION', 'ORGANIZATION');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "module" "AuditModule" NOT NULL,
    "targetId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_module_idx" ON "audit_logs"("organizationId", "module");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_actorId_idx" ON "audit_logs"("organizationId", "actorId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

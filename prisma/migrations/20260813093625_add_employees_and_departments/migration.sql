-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ONBOARDING', 'PROBATION', 'EXTENDED_PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'RESIGNED', 'RELEASED', 'TERMINATED', 'ABSCONDED', 'ON_HOLD');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "employeeIdCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "employeeIdPrefix" TEXT NOT NULL DEFAULT 'EMP';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "contactNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "designation" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "employeeId" TEXT NOT NULL,
ADD COLUMN     "employeeType" TEXT NOT NULL DEFAULT 'permanent',
ADD COLUMN     "employmentStatus" "EmploymentStatus" NOT NULL DEFAULT 'ONBOARDING',
ADD COLUMN     "joiningDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reportingManagerId" TEXT;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentHeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_organizationId_idx" ON "departments"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organizationId_name_key" ON "departments"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organizationId_code_key" ON "departments"("organizationId", "code");

-- CreateIndex
CREATE INDEX "users_departmentId_idx" ON "users"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_employeeId_key" ON "users"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_departmentHeadId_fkey" FOREIGN KEY ("departmentHeadId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_reportingManagerId_fkey" FOREIGN KEY ("reportingManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

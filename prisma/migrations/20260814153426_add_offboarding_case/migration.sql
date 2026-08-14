-- CreateEnum
CREATE TYPE "OffboardingStatus" AS ENUM ('INITIATED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "offboarding_cases" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "initiatedById" TEXT NOT NULL,
    "lastWorkingDay" TEXT NOT NULL,
    "reason" TEXT,
    "status" "OffboardingStatus" NOT NULL DEFAULT 'INITIATED',
    "assetsReturned" BOOLEAN NOT NULL DEFAULT false,
    "accessRevoked" BOOLEAN NOT NULL DEFAULT false,
    "exitInterviewDone" BOOLEAN NOT NULL DEFAULT false,
    "exitInterviewResponses" JSONB,
    "settlementId" TEXT,
    "notes" TEXT,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboarding_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offboarding_cases_organizationId_employeeId_idx" ON "offboarding_cases"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "OvertimeType" AS ENUM ('REGULAR', 'HOLIDAY', 'WEEKEND', 'NIGHT');

-- CreateEnum
CREATE TYPE "OvertimeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "overtime_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "type" "OvertimeType" NOT NULL DEFAULT 'REGULAR',
    "rateMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "status" "OvertimeStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_ratings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "payoutPercentage" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "notes" TEXT NOT NULL DEFAULT '',
    "ratedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "overtime_records_organizationId_employeeId_date_idx" ON "overtime_records"("organizationId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "performance_ratings_organizationId_idx" ON "performance_ratings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_ratings_organizationId_employeeId_financialYear_key" ON "performance_ratings"("organizationId", "employeeId", "financialYear");

-- AddForeignKey
ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_ratings" ADD CONSTRAINT "performance_ratings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_ratings" ADD CONSTRAINT "performance_ratings_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_ratings" ADD CONSTRAINT "performance_ratings_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

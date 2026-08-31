-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_off_patterns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "daysOff" JSONB NOT NULL DEFAULT '[0]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_off_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_organizationId_idx" ON "shifts"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_organizationId_name_key" ON "shifts"("organizationId", "name");

-- CreateIndex
CREATE INDEX "weekly_off_patterns_organizationId_idx" ON "weekly_off_patterns"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_off_patterns_organizationId_name_key" ON "weekly_off_patterns"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_off_patterns" ADD CONSTRAINT "weekly_off_patterns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

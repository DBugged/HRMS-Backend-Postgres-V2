-- CreateEnum
CREATE TYPE "LetterDataProfile" AS ENUM ('BASIC', 'EXIT', 'PAYROLL', 'SETTLEMENT');

-- CreateTable
CREATE TABLE "letter_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "addressedToEmployee" BOOLEAN NOT NULL DEFAULT true,
    "dataProfile" "LetterDataProfile" NOT NULL DEFAULT 'BASIC',
    "bodyText" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCustom" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "letter_templates_organizationId_idx" ON "letter_templates"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "letter_templates_organizationId_key_key" ON "letter_templates"("organizationId", "key");

-- AddForeignKey
ALTER TABLE "letter_templates" ADD CONSTRAINT "letter_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

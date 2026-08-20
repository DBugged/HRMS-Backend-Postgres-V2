-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "faceApiKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_faceApiKey_key" ON "organizations"("faceApiKey");

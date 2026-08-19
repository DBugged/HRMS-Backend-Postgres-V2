-- AlterTable
ALTER TABLE "users" ADD COLUMN     "officialEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_officialEmail_key" ON "users"("officialEmail");

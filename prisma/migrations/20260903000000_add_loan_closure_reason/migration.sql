-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "closureReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" TEXT;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

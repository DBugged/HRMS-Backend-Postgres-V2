-- AlterTable
ALTER TABLE "reimbursements" ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "paidDate" TEXT;

-- AddForeignKey
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

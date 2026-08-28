-- CreateEnum
CREATE TYPE "ReimbursementPaymentMode" AS ENUM ('CASH', 'CHEQUE', 'TRANSFER');

-- AlterTable
ALTER TABLE "reimbursements" ADD COLUMN     "approvedDate" TEXT,
ADD COLUMN     "paymentMode" "ReimbursementPaymentMode";

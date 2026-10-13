-- What the employee still owes after the final settlement (recoveries above the payout).
CREATE TYPE "ReceivableStatus" AS ENUM ('NONE', 'DUE', 'RECOVERED', 'WAIVED');

ALTER TABLE "settlements"
  ADD COLUMN "receivableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "receivableStatus" "ReceivableStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "receivableNote" TEXT,
  ADD COLUMN "receivableClosedAt" TIMESTAMP(3),
  ADD COLUMN "receivableClosedById" TEXT;

-- The reviewer's note on a comp-off or an overtime decision (leave, reimbursement, regularization and WFH already
-- carry one), so a rejection can say why. Nullable: existing rows and decisions made without a note stay as they are.
ALTER TABLE "comp_offs" ADD COLUMN "decisionNote" TEXT;
ALTER TABLE "overtime_records" ADD COLUMN "decisionNote" TEXT;

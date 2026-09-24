-- executeImportBatch now claims a batch (VALIDATED -> EXECUTING) with a
-- guarded compare-and-swap before writing to the attendance ledger, so two
-- concurrent executes can't both import every row; an unexpected failure
-- marks the batch FAILED instead of leaving it stuck in EXECUTING.
ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'FAILED';

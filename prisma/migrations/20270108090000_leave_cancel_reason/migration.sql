-- Why a leave was cancelled (written by whoever cancelled it; empty for older cancellations).
ALTER TABLE "leaves" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT NOT NULL DEFAULT '';

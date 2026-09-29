-- Renames LeaveType.autoApproveDays -> autoApproveHours: this column was
-- previously a dead field (no code path ever read it — see
-- LeavesService.autoApprovePendingLeaves, now the first consumer). Hours
-- rather than days lets a same-day SLA be expressed. RENAME COLUMN
-- preserves existing values as-is (any org that had already set a "days"
-- value now has that same number interpreted as hours) — acceptable since
-- the field was never actually enforced before this migration.
ALTER TABLE "leave_types" RENAME COLUMN "autoApproveDays" TO "autoApproveHours";

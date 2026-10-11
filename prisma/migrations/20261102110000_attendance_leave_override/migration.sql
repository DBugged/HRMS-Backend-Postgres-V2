-- Remember what an attendance day was before an approved leave stamped it, so cancelling the leave restores it.
-- Additive; existing rows have none.
ALTER TABLE "attendances" ADD COLUMN "leaveOverriddenStatus" "AttendanceStatus";
ALTER TABLE "attendances" ADD COLUMN "leaveOverriddenSource" "AttendanceSource";

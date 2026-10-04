-- Per-leave-type switch for the Leave Tracker balances view/export (display only).
ALTER TABLE "leave_types" ADD COLUMN "showInLeaveTracker" BOOLEAN NOT NULL DEFAULT true;

-- One overtime record per employee/day regardless of source. Without this,
-- OvertimeService.log() (manual entry) and AttendanceService's own
-- punch-out auto-suggestion (source=AUTO_PUNCH) could both create a row for
-- the same employee/day, both get approved independently, and double-pay
-- the same overshoot in payroll's monthly overtime sum.
DROP INDEX IF EXISTS "overtime_records_organizationId_employeeId_date_idx";

CREATE UNIQUE INDEX "overtime_records_organizationId_employeeId_date_key" ON "overtime_records"("organizationId", "employeeId", "date");

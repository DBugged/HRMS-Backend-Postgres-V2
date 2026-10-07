-- A real punch-in with no punch-out, once the shift has ended, used to default straight to
-- ABSENT (no distinct way to tell "forgot to punch out" from "never showed up"). INCOMPLETE
-- gives it its own status so it can be surfaced to the employee/HR and resolved via the
-- existing regularization flow instead of silently costing the employee a day's pay.
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';

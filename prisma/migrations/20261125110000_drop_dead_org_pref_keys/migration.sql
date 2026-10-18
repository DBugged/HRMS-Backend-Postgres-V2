-- New organizations no longer get org attendance/payroll preference keys that nothing reads and no screen shows (the
-- real switches live elsewhere: Payroll Settings, the leave switches, the tax declaration rules). Only the column
-- default changes: existing organizations keep whatever they already have stored, so nothing is deleted or altered.
ALTER TABLE "organizations" ALTER COLUMN "orgPayrollAttendancePrefs" SET DEFAULT '{"defaultShiftStartTime":"09:30","defaultShiftEndTime":"18:30","defaultLateInThresholdMinutes":15,"defaultEarlyOutThresholdMinutes":15,"defaultMinHoursForPresent":8,"defaultMinHoursForHalfDay":4,"defaultWorkWeek":"monday-friday","weekendDays":[0,6],"defaultWorkingHoursPerDay":8}';

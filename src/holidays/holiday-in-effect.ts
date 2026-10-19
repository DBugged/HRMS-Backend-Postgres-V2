// Purpose: which holidays count when attendance, leave tracker, overtime and payroll look at a day.
// Responsibilities: one shared filter - an active holiday, or a reference holiday (one loaded from a calendar upload after
//   its date had passed, saved inactive so it can't be edited or deleted).
// Important: reference holidays are real holidays for that day: a day on one shows as Holiday, not Absent, and is not
//   counted as a working day. A holiday an Admin switched off (inactive and not a reference) still never counts. Locked
//   payroll months are protected where attendance is repaired (see AttendanceService.applyReferenceHolidays), not here.
import type { Prisma } from '@prisma/client';

export const holidayInEffect: Prisma.HolidayWhereInput = {
  OR: [{ isActive: true }, { isReference: true }],
};

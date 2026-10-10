import { resolveShiftConfig } from '../attendance/attendance-shift-config';
import type { OrganizationAttendancePrefs } from '../attendance/attendance-shift-config';

// The slice of a Prisma client this needs — works with both the raw and the tenant-scoped client.
interface DepartmentWriter {
  department: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

const FIELDS = [
  'shiftStartTime',
  'shiftEndTime',
  'lateInThresholdMinutes',
  'earlyOutThresholdMinutes',
  'minHoursForPresent',
  'minHoursForHalfDay',
  'breakMinutes',
] as const;

/**
 * Shift start/end, late-in / early-out thresholds, minimum hours for Present / Half Day and the break time default
 * from Organization Settings, and each department may still override them. When the org defaults change, a department
 * still sitting on the OLD org value (i.e. never customised) follows the new one; a department someone edited
 * keeps its own value. Shift hours and break time of a department with a Work Schedule belong to that schedule and
 * are left alone.
 */
export async function cascadeOrgAttendanceDefaults(
  db: DepartmentWriter,
  organizationId: string,
  oldPrefs: OrganizationAttendancePrefs | null | undefined,
  newPrefs: OrganizationAttendancePrefs | null | undefined,
): Promise<void> {
  const before = resolveShiftConfig(null, oldPrefs);
  const after = resolveShiftConfig(null, newPrefs);
  for (const field of FIELDS) {
    if (before[field] === after[field]) continue;
    await db.department.updateMany({
      where: {
        organizationId,
        [field]: before[field],
        // Break time and shift hours of a department with a Work Schedule belong to that schedule.
        ...(field === 'breakMinutes' ||
        field === 'shiftStartTime' ||
        field === 'shiftEndTime'
          ? { workScheduleId: null }
          : {}),
      },
      data: { [field]: after[field] },
    });
  }
}

/** The org-level values a department starts from (and can be reset to). */
export function orgAttendanceDefaults(
  prefs: OrganizationAttendancePrefs | null | undefined,
) {
  const c = resolveShiftConfig(null, prefs);
  return {
    lateInThresholdMinutes: c.lateInThresholdMinutes,
    earlyOutThresholdMinutes: c.earlyOutThresholdMinutes,
    minHoursForPresent: c.minHoursForPresent,
    minHoursForHalfDay: c.minHoursForHalfDay,
    breakMinutes: c.breakMinutes,
  };
}

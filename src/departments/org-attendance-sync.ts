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

/**
 * Late-in / early-out thresholds, minimum hours for Present / Half Day and the break time are organisation
 * policy, not a per-department choice: every department takes them from Organization Settings. A department
 * assigned a Work Schedule keeps that schedule's break time (the schedule owns it); everything else follows the
 * org. A no-op when the departments already match, so it is cheap to call on reads and writes alike.
 */
export async function syncDepartmentsToOrgAttendance(
  db: DepartmentWriter,
  organizationId: string,
  orgPrefs: OrganizationAttendancePrefs | null | undefined,
): Promise<void> {
  const cfg = resolveShiftConfig(null, orgPrefs);
  await db.department.updateMany({
    where: {
      organizationId,
      OR: [
        { lateInThresholdMinutes: { not: cfg.lateInThresholdMinutes } },
        { earlyOutThresholdMinutes: { not: cfg.earlyOutThresholdMinutes } },
        { minHoursForPresent: { not: cfg.minHoursForPresent } },
        { minHoursForHalfDay: { not: cfg.minHoursForHalfDay } },
      ],
    },
    data: {
      lateInThresholdMinutes: cfg.lateInThresholdMinutes,
      earlyOutThresholdMinutes: cfg.earlyOutThresholdMinutes,
      minHoursForPresent: cfg.minHoursForPresent,
      minHoursForHalfDay: cfg.minHoursForHalfDay,
    },
  });
  await db.department.updateMany({
    where: {
      organizationId,
      workScheduleId: null,
      breakMinutes: { not: cfg.breakMinutes },
    },
    data: { breakMinutes: cfg.breakMinutes },
  });
}

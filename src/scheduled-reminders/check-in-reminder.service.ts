// Purpose: a nudge shortly before an employee's shift starts - "your shift starts at 9:30 AM, mark your attendance".
// Responsibilities: every 5 minutes, for each organization that has the reminder on, finds the active employees whose
//   shift (their department's, else the company default) starts N minutes from now in the company's own clock and who
//   have not checked in, and notifies them in-app (and on their phone, through the usual push preferences).
// Important: Admin-configurable (Org Settings > Attendance & Leave: on/off and how many minutes before; on, 15 minutes by
//   default). Nobody is nudged on a weekly off, a holiday (company-wide or their department's), a full day of approved
//   leave, before they have joined, or once they have already punched in. One reminder per person per day (the
//   notification title carries the date), even if the job re-runs.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeaveStatus, NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { dateStrInOrgTz } from '../common/org-date';
import { holidayInEffect } from '../holidays/holiday-in-effect';
import {
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import {
  isReminderMoment,
  minutesOfDay,
  resolveCheckInReminder,
  shiftTimeLabel,
} from './check-in-reminder';

@Injectable()
export class CheckInReminderService {
  private readonly logger = new Logger(CheckInReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron('*/5 * * * *')
  async sendReminders(): Promise<number> {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    let sent = 0;
    for (const org of organizations) {
      try {
        sent += await this.remindForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `Check-in reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
    return sent;
  }

  // `now` is injectable so the moment can be tested without waiting for the clock.
  async remindForOrg(
    organizationId: string,
    now = new Date(),
  ): Promise<number> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        timezone: true,
        policies: true,
        attendancePayrollPrefs: true,
        orgPayrollAttendancePrefs: true,
      },
    });
    if (!org) return 0;
    const settings = resolveCheckInReminder(org.orgPayrollAttendancePrefs);
    if (!settings.enabled) return 0;

    const timezone = org.timezone || 'Asia/Kolkata';
    const today = dateStrInOrgTz(timezone, now);
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const nowMinutes = minutesOfDay(clock);
    if (nowMinutes === null) return 0;
    const hour12 =
      (org.policies as { timeFormat?: string } | null)?.timeFormat === '12';

    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        joiningDate: { lte: new Date(`${today}T00:00:00.000Z`) },
      },
      select: {
        id: true,
        departmentId: true,
        department: true,
      },
    });
    if (employees.length === 0) return 0;

    // Everyone's shift first: only the people whose shift is at its reminder moment need the lookups below.
    const orgPrefs =
      org.attendancePayrollPrefs as OrganizationAttendancePrefs | null;
    const due = employees
      .map((e) => ({
        ...e,
        shift: resolveShiftConfig(e.department, orgPrefs, timezone),
      }))
      .filter((e) => {
        const start = minutesOfDay(e.shift.shiftStartTime);
        return (
          start !== null &&
          isReminderMoment(start, nowMinutes, settings.minutesBefore) &&
          !isWeeklyOff(today, e.shift.weeklyOffs)
        );
      });
    if (due.length === 0) return 0;

    const ids = due.map((e) => e.id);
    const [punched, onLeave, holidays] = await Promise.all([
      this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: { in: ids },
          date: today,
          inTime: { not: null },
        },
        select: { employeeId: true },
      }),
      this.scopedPrisma.leave.findMany({
        where: {
          organizationId,
          employeeId: { in: ids },
          status: LeaveStatus.APPROVED,
          isHalfDay: false,
          startDate: { lte: today },
          endDate: { gte: today },
        },
        select: { employeeId: true },
      }),
      this.scopedPrisma.holiday.findMany({
        where: {
          organizationId,
          AND: [holidayInEffect],
          isOptional: false,
          date: today,
        },
        select: { departmentId: true },
      }),
    ]);
    const skip = new Set([
      ...punched.map((p) => p.employeeId),
      ...onLeave.map((l) => l.employeeId),
    ]);

    let sent = 0;
    for (const e of due) {
      if (skip.has(e.id)) continue;
      if (
        holidays.some(
          (h) => h.departmentId === null || h.departmentId === e.departmentId,
        )
      ) {
        continue;
      }
      const at = shiftTimeLabel(e.shift.shiftStartTime, hour12);
      // The date in the title is what keeps a re-run (or a restart in the same window) from reminding twice.
      const title = `Mark your attendance - shift starts at ${at} (${today})`;
      const already = await this.scopedPrisma.notification.findFirst({
        where: {
          organizationId,
          userId: e.id,
          title,
          // Measured against the real clock (when notifications are stamped), not the injectable `now`.
          createdAt: { gt: new Date(Date.now() - 20 * 3600_000) },
        },
        select: { id: true },
      });
      if (already) continue;
      await this.notificationsService.create({
        organizationId,
        userId: e.id,
        title,
        message: `Your shift starts at ${at}. Remember to check in when you arrive.`,
        category: NotificationCategory.ATTENDANCE,
      });
      sent += 1;
    }
    return sent;
  }
}

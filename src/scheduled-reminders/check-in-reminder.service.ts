// Purpose: a nudge shortly before an employee's shift starts - "your shift starts at 9:30 AM, mark your attendance".
// Responsibilities: every 5 minutes, for each organization that has the reminder on, finds the active employees whose
//   shift (their department's, else the company default) starts N minutes from now in the company's own clock and who
//   have not checked in, and notifies them in-app (and on their phone, through the usual push preferences).
// Important: Admin-configurable (Org Settings > Attendance & Leave: on/off and how many minutes before; on, 15 minutes by
//   default). Nobody is nudged on a weekly off, a holiday (company-wide or their department's), a full day of approved
//   leave, before they have joined, or once they have already punched in. One reminder per person per day (the
//   notification title carries the date), even if the job re-runs.
import { dmyText } from '../payroll/format-date';
import { keepModuleEnabled } from '../module-access/module-gate';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeaveStatus, NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { dateStrInOrgTz, yesterdayInOrgTz } from '../common/org-date';
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
  resolveCheckOutReminder,
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
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    let sent = 0;
    for (const org of organizations) {
      try {
        sent += await this.remindForOrg(org.id);
        sent += await this.remindCheckOutForOrg(org.id);
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
        // Always-present employees do not punch, so they are not reminded to.
        alwaysPresent: false,
        joiningDate: { lte: new Date(`${today}T23:59:59.999Z`) }, // joined today, at any time
        // Not after their last working day.
        OR: [{ exitDate: null }, { exitDate: { gte: today } }],
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
      const title = `Mark your attendance - shift starts at ${at} (${dmyText(today)})`;
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

  // "Remember to check out": N minutes before the shift ends, for people who checked in and have not checked out yet.
  // Unlike the check-in reminder, the day type does not matter - someone who punched in (even on a weekly off or a
  // holiday) is working and gets it. A shift that crosses midnight is looked up on the day it started.
  async remindCheckOutForOrg(
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
    const settings = resolveCheckOutReminder(org.orgPayrollAttendancePrefs);
    if (!settings.enabled) return 0;

    const timezone = org.timezone || 'Asia/Kolkata';
    const today = dateStrInOrgTz(timezone, now);
    const yesterday = yesterdayInOrgTz(timezone, now);
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
    const orgPrefs =
      org.attendancePayrollPrefs as OrganizationAttendancePrefs | null;

    const open = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        date: { in: [today, yesterday] },
        inTime: { not: null },
        outTime: null,
        employee: { isActive: true },
      },
      select: {
        employeeId: true,
        date: true,
        employee: { select: { department: true } },
      },
    });

    let sent = 0;
    for (const row of open) {
      const shift = resolveShiftConfig(
        row.employee.department,
        orgPrefs,
        timezone,
      );
      // The shift's own day: today normally, the day before for a shift that ends after midnight.
      const shiftDate = shift.crossesMidnight ? yesterday : today;
      if (row.date !== shiftDate) continue;
      const end = minutesOfDay(shift.shiftEndTime);
      if (
        end === null ||
        !isReminderMoment(end, nowMinutes, settings.minutesBefore)
      ) {
        continue;
      }
      const at = shiftTimeLabel(shift.shiftEndTime, hour12);
      const title = `Remember to check out - shift ends at ${at} (${dmyText(row.date)})`;
      const already = await this.scopedPrisma.notification.findFirst({
        where: {
          organizationId,
          userId: row.employeeId,
          title,
          createdAt: { gt: new Date(Date.now() - 20 * 3600_000) },
        },
        select: { id: true },
      });
      if (already) continue;
      await this.notificationsService.create({
        organizationId,
        userId: row.employeeId,
        title,
        message: `Your shift ends at ${at}. Remember to check out when you leave.`,
        category: NotificationCategory.ATTENDANCE,
      });
      sent += 1;
    }
    return sent;
  }
}

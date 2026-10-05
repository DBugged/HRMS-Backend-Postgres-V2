// Purpose: Reminder to HR/Admin shortly before payroll is processed, listing the pending requests that would change
// the payroll if they are not decided first.
// Responsibilities: 3 days and 1 day before the org's payroll processing date (Payroll Calendar processingDay,
// 0 = last working day), counts pending leave, attendance regularization, Work From Home, overtime and loan/advance
// requests for the month being processed, and notifies every active HR/Admin via PAYROLL_CUTOFF_REMINDER.
// Important: nothing is sent when nothing is pending. Leave counts requests overlapping the month; attendance and
// overtime count only that month's dates; loans count every pending request.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  LeaveStatus,
  LoanStatus,
  NotificationCategory,
  OvertimeStatus,
  Role,
  WfhApprovalStatus,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { resolveDayOfMonth } from '../payroll-settings/payroll-date';
import {
  OrganizationAttendancePrefs,
  resolveShiftConfig,
} from '../attendance/attendance-shift-config';
import { ReminderNotifier } from './reminder-notifier.service';
import {
  PAYROLL_CUTOFF_REMINDER_DAYS,
  dateOf,
  daysBetween,
  monthLabel,
} from './reminder-dates';

@Injectable()
export class PayrollCutoffReminderService {
  private readonly logger = new Logger(PayrollCutoffReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
    private readonly payrollSettings: PayrollSettingsService,
  ) {}

  @Cron('0 9 * * *')
  async sendDailyReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(
          `Payroll cut-off reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const [settings, org] = await Promise.all([
      this.payrollSettings.getOrCreate(organizationId),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      }),
    ]);
    const { weeklyOffs } = resolveShiftConfig(
      null,
      (org?.attendancePayrollPrefs ??
        null) as OrganizationAttendancePrefs | null,
    );
    const [year, month] = today.split('-').map(Number);
    // This month's processing date, or next month's once this month's has passed.
    let processingDate = resolveDayOfMonth(
      settings.processingDay,
      year,
      month,
      weeklyOffs,
    );
    if (processingDate < today) {
      const next = dateOf(year, month + 1, 1)
        .split('-')
        .map(Number);
      processingDate = resolveDayOfMonth(
        settings.processingDay,
        next[0],
        next[1],
        weeklyOffs,
      );
    }
    const daysLeft = daysBetween(today, processingDate);
    if (!PAYROLL_CUTOFF_REMINDER_DAYS.includes(daysLeft)) return 0;

    const monthPrefix = processingDate.slice(0, 7);
    const monthStart = `${monthPrefix}-01`;
    const monthEnd = dateOf(
      Number(monthPrefix.slice(0, 4)),
      Number(monthPrefix.slice(5, 7)),
      31,
    );
    const p = this.scopedPrisma;
    const [leave, regularization, wfh, overtime, loan] = await Promise.all([
      p.leave.count({
        where: {
          organizationId,
          status: LeaveStatus.PENDING,
          startDate: { lte: monthEnd },
          endDate: { gte: monthStart },
        },
      }),
      p.attendance.count({
        where: {
          organizationId,
          date: { startsWith: monthPrefix },
          regularization: { path: ['status'], equals: 'pending' },
        },
      }),
      p.attendance.count({
        where: {
          organizationId,
          date: { startsWith: monthPrefix },
          workArrangementStatus: WfhApprovalStatus.PENDING,
        },
      }),
      p.overtimeRecord.count({
        where: {
          organizationId,
          date: { startsWith: monthPrefix },
          status: OvertimeStatus.PENDING,
        },
      }),
      p.loan.count({ where: { organizationId, status: LoanStatus.PENDING } }),
    ]);
    const total = leave + regularization + wfh + overtime + loan;
    if (total === 0) return 0;

    const shown = (n: number) => (n > 0 ? String(n) : ''); // '' hides the row in the template
    const processingDisplay = formatDateDisplay(processingDate, '');
    const recipients = (await this.notifier.activeUsers(organizationId)).filter(
      (u) => u.role === Role.HR || u.role === Role.ADMIN,
    );
    let sent = 0;
    for (const user of recipients) {
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'PAYROLL_CUTOFF_REMINDER',
        variables: {
          employeeName: user.name,
          payrollMonth: monthLabel(monthPrefix),
          processingDate: processingDisplay,
          daysLeft: String(daysLeft),
          totalPending: String(total),
          leaveCount: shown(leave),
          regularizationCount: shown(regularization),
          wfhCount: shown(wfh),
          overtimeCount: shown(overtime),
          loanCount: shown(loan),
          reviewUrl: frontendUrl(),
        },
        title: `Payroll processing on ${processingDisplay}: ${total} item(s) pending (${daysLeft} day${daysLeft === 1 ? '' : 's'} to go)`,
        message: `${total} pending request(s) will affect ${monthLabel(monthPrefix)} payroll. Decide them before ${processingDisplay}.`,
        category: NotificationCategory.PAYROLL,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}

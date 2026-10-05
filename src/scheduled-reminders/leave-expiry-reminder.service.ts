// Purpose: Warns employees before leave balance lapses, so unused days are used, carried forward or encashed on
// purpose instead of vanishing at year-end.
// Responsibilities: runs daily and, 30 days before the lapse date and then every Monday until it, sends each
// affected employee one message listing (a) year-end lapse: days above what the leave type lets them carry forward
// (all of it if carry-forward is off), noting encashment when allowed, and (b) carried-in days that expire within
// 30 days (LeaveBalance.carriedInExpiresOn). Leave years are calendar years, so year-end is 31 December.
// Important: respects the org-wide carry-forward/encashment switches; unlimited, no-allocation and comp-off types
// never lapse; the title carries the date so a re-run the same day is a no-op.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AllocationType, NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { LEAVE_TYPE_CODES } from '../common/reserved-codes';
import { readOrgLeaveSwitches } from '../organizations/org-leave-switches';
import { computeCarryOut } from '../leave-balances/leave-balance-math';
import { ReminderNotifier } from './reminder-notifier.service';
import { LEAVE_EXPIRY_LEAD_DAYS, leaveExpiryDaysLeft } from './reminder-dates';

interface CarryForwardRules {
  allowed?: boolean;
  maxDays?: number;
}
interface EncashmentRules {
  allowed?: boolean;
  maxDaysPerYear?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class LeaveExpiryReminderService {
  private readonly logger = new Logger(LeaveExpiryReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('15 9 * * *')
  async sendReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(
          `Leave expiry reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const year = Number(today.slice(0, 4));
    const yearEnd = `${year}-12-31`;
    const yearEndDaysLeft = leaveExpiryDaysLeft(today, yearEnd);
    const upcomingCutoff = new Date(
      Date.UTC(
        year,
        Number(today.slice(5, 7)) - 1,
        Number(today.slice(8, 10)) + LEAVE_EXPIRY_LEAD_DAYS,
      ),
    )
      .toISOString()
      .slice(0, 10);

    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { policies: true },
    });
    const switches = readOrgLeaveSwitches(org?.policies);

    const rows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        year,
        closing: { gt: 0 },
        leaveType: {
          isActive: true,
          code: { not: LEAVE_TYPE_CODES.COMPOFF },
          allocationType: {
            notIn: [AllocationType.NONE, AllocationType.UNLIMITED],
          },
        },
        employee: { isActive: true },
      },
      include: {
        leaveType: {
          select: { name: true, carryForward: true, encashment: true },
        },
        employee: {
          select: {
            id: true,
            name: true,
            email: true,
            notificationPreferences: true,
          },
        },
      },
    });

    const perEmployee = new Map<
      string,
      {
        employee: (typeof rows)[number]['employee'];
        lines: string[];
        daysLeft: number;
      }
    >();
    const add = (
      row: (typeof rows)[number],
      line: string,
      daysLeft: number,
    ) => {
      const entry = perEmployee.get(row.employeeId) ?? {
        employee: row.employee,
        lines: [],
        daysLeft,
      };
      entry.lines.push(line);
      entry.daysLeft = Math.min(entry.daysLeft, daysLeft);
      perEmployee.set(row.employeeId, entry);
    };

    for (const row of rows) {
      const cf = row.leaveType.carryForward as CarryForwardRules;
      const enc = row.leaveType.encashment as EncashmentRules;
      const canEncash = switches.allowLeaveEncashment && enc.allowed === true;

      // (a) Year-end lapse.
      if (yearEndDaysLeft !== null) {
        const carry =
          switches.allowCarryForward && cf.allowed === true
            ? computeCarryOut(row.closing, cf.maxDays ?? 0)
            : 0;
        const lapse = round(row.closing - carry);
        if (lapse > 0) {
          const encashNote = canEncash
            ? enc.maxDaysPerYear
              ? ` (up to ${enc.maxDaysPerYear} days can be encashed)`
              : ' (can be encashed)'
            : '';
          add(
            row,
            `${row.leaveType.name}: ${lapse} day(s) lapse on ${formatDateDisplay(yearEnd, '')}${encashNote}`,
            yearEndDaysLeft,
          );
        }
      }

      // (b) Carried-in days with an expiry date coming up.
      const expiry = row.carriedInExpiresOn;
      if (expiry && expiry >= today && expiry <= upcomingCutoff) {
        const expiring = round(Math.min(row.opening, row.closing));
        const daysLeft = leaveExpiryDaysLeft(today, expiry);
        if (expiring > 0 && daysLeft !== null) {
          add(
            row,
            `${row.leaveType.name}: ${expiring} carried-forward day(s) expire on ${formatDateDisplay(expiry, '')}`,
            daysLeft,
          );
        }
      }
    }

    const displayToday = formatDateDisplay(today, '');
    let sent = 0;
    for (const { employee, lines, daysLeft } of perEmployee.values()) {
      const delivered = await this.notifier.send({
        organizationId,
        user: employee,
        occasionKey: 'LEAVE_EXPIRY_REMINDER',
        variables: {
          employeeName: employee.name,
          leaveSummary: lines.join('; '),
          daysLeft: String(daysLeft),
          reviewUrl: `${frontendUrl()}/leaves`,
        },
        title: `Leave balance expiring soon (${displayToday})`,
        message: lines.join('; '),
        category: NotificationCategory.LEAVE,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}

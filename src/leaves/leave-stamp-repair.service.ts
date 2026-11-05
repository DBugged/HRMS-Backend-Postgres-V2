// Purpose: one-time (re-runnable) repair of attendance days that older leave approvals wrongly marked as On Leave - a holiday or
//   weekly off inside a leave whose type's sandwich rule leaves it out. The rules live in leave-stamp-repair.ts.
// Responsibilities: reads the company's approved leaves, calendar and On Leave rows; reports what it would put back (dry run, the
//   default) or puts it back; skips days in a locked or paid payroll month; marks open payroll runs for recalculation; audits the fix.
// Important: Admin only (see the controller). Nothing is changed unless dryRun is explicitly false. Running it again finds nothing
//   more to do.
import { Inject, Injectable } from '@nestjs/common';
import {
  AttendanceSource,
  AttendanceStatus,
  LeaveStatus,
  PayrollRunStatus,
  type User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import { markPayrollInputsChanged } from '../payroll/payroll-period-guard';
import {
  chargedKindsOf,
  effectiveLeaveRules,
  type LeaveRules,
} from './leave-rules';
import { planStampRepair, type RepairAction } from './leave-stamp-repair';

type Actor = Omit<User, 'password'>;

export interface RepairReport {
  dryRun: boolean;
  leavesChecked: number;
  /** Days that were marked On Leave by mistake. */
  daysFound: number;
  /** Days left alone because their payroll month is locked or paid. */
  skippedLocked: number;
  /** Days put back (0 on a dry run). */
  daysFixed: number;
  /** The first 300 days, for the preview. */
  items: {
    employee: string;
    employeeId: string;
    date: string;
    becomes: string;
  }[];
}

const SHOWN = 300;

@Injectable()
export class LeaveStampRepairService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditLogService,
  ) {}

  async run(
    actor: Actor,
    organizationId: string,
    dryRun = true,
  ): Promise<RepairReport> {
    const leaves = await this.db.leave.findMany({
      where: { organizationId, status: LeaveStatus.APPROVED },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        isHalfDay: true,
        totalDays: true,
        leaveType: {
          select: { rules: true, allocationType: true, eventGrant: true },
        },
      },
    });
    const employeeIds = [...new Set(leaves.map((l) => l.employeeId))];
    if (employeeIds.length === 0)
      return this.report(dryRun, 0, [], 0, 0, new Map());

    const [org, people, holidays, rows] = await Promise.all([
      this.db.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true, timezone: true },
      }),
      this.db.user.findMany({
        where: { id: { in: employeeIds }, organizationId },
        select: {
          id: true,
          name: true,
          employeeId: true,
          departmentId: true,
          department: true,
        },
      }),
      this.db.holiday.findMany({
        where: { organizationId, isActive: true, isOptional: false },
        select: { date: true, departmentId: true },
      }),
      this.db.attendance.findMany({
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          status: AttendanceStatus.ON_LEAVE,
          source: AttendanceSource.SYSTEM,
        },
        select: {
          id: true,
          employeeId: true,
          date: true,
          status: true,
          source: true,
          leaveOverriddenStatus: true,
          leaveOverriddenSource: true,
        },
      }),
    ]);
    const orgPrefs =
      (org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null) ??
      null;
    const byPerson = new Map(people.map((p) => [p.id, p]));
    const calendarOf = (employeeId: string) => {
      const p = byPerson.get(employeeId);
      return {
        weeklyOffs: resolveShiftConfig(
          p?.department ?? null,
          orgPrefs,
          org?.timezone,
        ).weeklyOffs,
        holidayDates: new Set(
          holidays
            .filter(
              (h) =>
                h.departmentId === null || h.departmentId === p?.departmentId,
            )
            .map((h) => h.date),
        ),
      };
    };

    const planned = planStampRepair(
      leaves.map((l) => ({
        id: l.id,
        employeeId: l.employeeId,
        startDate: l.startDate,
        endDate: l.endDate,
        isHalfDay: l.isHalfDay,
        totalDays: l.totalDays,
        kinds: chargedKindsOf(
          effectiveLeaveRules(
            l.leaveType.rules as unknown as LeaveRules,
            l.leaveType,
          ),
        ),
      })),
      calendarOf,
      rows.map((r) => ({
        ...r,
        status: r.status as string,
        source: r.source as string,
      })),
    );

    // A locked or paid payroll month is never touched.
    const lockedRuns = planned.length
      ? await this.db.payrollRun.findMany({
          where: {
            organizationId,
            employeeId: { in: [...new Set(planned.map((a) => a.employeeId))] },
            isFinalSettlement: false,
            runSequence: 0,
            status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
          },
          select: { employeeId: true, month: true, year: true },
        })
      : [];
    const locked = new Set(
      lockedRuns.map(
        (r) => `${r.employeeId}|${r.year}-${String(r.month).padStart(2, '0')}`,
      ),
    );
    const allowed = planned.filter(
      (a) => !locked.has(`${a.employeeId}|${a.date.slice(0, 7)}`),
    );
    const skippedLocked = planned.length - allowed.length;

    let fixed = 0;
    if (!dryRun && allowed.length > 0) {
      const perPerson = new Map<string, RepairAction[]>();
      for (const a of allowed)
        perPerson.set(a.employeeId, [
          ...(perPerson.get(a.employeeId) ?? []),
          a,
        ]);
      for (const [employeeId, actions] of perPerson) {
        const months = [...new Set(actions.map((a) => a.date.slice(0, 7)))].map(
          (m) => ({
            year: Number(m.slice(0, 4)),
            month: Number(m.slice(5, 7)),
          }),
        );
        await this.db.$transaction(async (tx) => {
          const deletes = actions
            .filter((a) => a.action === 'DELETE')
            .map((a) => a.rowId);
          if (deletes.length > 0) {
            await tx.attendance.deleteMany({
              where: { id: { in: deletes }, organizationId },
            });
          }
          for (const a of actions.filter((x) => x.action === 'RESTORE')) {
            await tx.attendance.updateMany({
              where: { id: a.rowId, organizationId },
              data: {
                status: a.restoreStatus as AttendanceStatus,
                source:
                  (a.restoreSource as AttendanceSource | null) ??
                  AttendanceSource.FACE_API,
                leaveOverriddenStatus: null,
                leaveOverriddenSource: null,
              },
            });
          }
          await markPayrollInputsChanged(
            tx,
            organizationId,
            employeeId,
            months,
          );
        });
        fixed += actions.length;
      }
      await this.audit.log({
        actorId: actor.id,
        action: 'LEAVE_ATTENDANCE_REPAIRED',
        module: 'ATTENDANCE',
        organizationId,
        targetId: organizationId,
        details: {
          daysFixed: fixed,
          skippedLocked,
          leavesChecked: leaves.length,
        },
      });
    }
    return this.report(
      dryRun,
      leaves.length,
      allowed,
      skippedLocked,
      fixed,
      byPerson,
    );
  }

  private report(
    dryRun: boolean,
    leavesChecked: number,
    allowed: RepairAction[],
    skippedLocked: number,
    daysFixed: number,
    people: Map<string, { name: string; employeeId: string }>,
  ): RepairReport {
    return {
      dryRun,
      leavesChecked,
      daysFound: allowed.length + skippedLocked,
      skippedLocked,
      daysFixed,
      items: allowed
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, SHOWN)
        .map((a) => ({
          employee: people.get(a.employeeId)?.name ?? '',
          employeeId: people.get(a.employeeId)?.employeeId ?? '',
          date: a.date,
          becomes:
            a.action === 'RESTORE'
              ? String(a.restoreStatus).toLowerCase().replace(/_/g, ' ')
              : 'holiday / weekly off from the calendar',
        })),
    };
  }
}

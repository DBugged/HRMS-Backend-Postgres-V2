// Purpose: Reads the organisation's leave year and performs the one-off move from the calendar year to a leave year that
//   starts in another month (April = 4).
// Responsibilities: GET the current setting and year; preview / run the transition.
// Important: the transition EXTENDS the calendar year in progress to the day before the new start month, so the next
//   year starts in that month. It is allowed only (a) for an organisation with no leave data yet, or (b) from January to
//   another month; any other change would overlap or leave a gap in the balance years and is refused. Running it
//   re-files every pending / approved leave that falls on or after 1 January of the anchor year under the new years and
//   moves the leave days between the affected balance rows by the difference, then tops the extended year's upfront
//   credit up to its longer length. Admin only.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AllocationType,
  LeaveStatus,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import {
  currentLeaveYear,
  LeaveYearConfig,
  leaveYearBounds,
  leaveYearLabel,
} from '../leave-balances/leave-year';
import { getLeaveYearConfig } from '../leave-balances/leave-year-config';
import { todayInOrgTz } from '../common/org-date';
import {
  splitDaysByYear,
  effectiveLeaveRules,
  LeaveRules,
} from '../leaves/leave-rules';
import { resolveShiftConfig } from '../attendance/attendance-shift-config';
import type { OrganizationAttendancePrefs } from '../attendance/attendance-shift-config';
import { LEAVE_TYPE_CODES } from '../common/reserved-codes';
import { TransitionLeaveYearDto } from './dto/transition-leave-year.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class LeaveYearService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private describe(key: number, cfg: LeaveYearConfig) {
    const b = leaveYearBounds(key, cfg);
    return {
      key,
      label: leaveYearLabel(key, cfg),
      start: b.start,
      end: b.end,
      months: b.months,
    };
  }

  async get(organizationId: string) {
    const [cfg, org] = await Promise.all([
      getLeaveYearConfig(this.scopedPrisma, organizationId),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { timezone: true },
      }),
    ]);
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const key = currentLeaveYear(today, cfg);
    return {
      startMonth: cfg.startMonth,
      anchorYear: cfg.anchorYear,
      current: this.describe(key, cfg),
    };
  }

  // The whole transition, or (dryRun) what it would do.
  async transition(
    dto: TransitionLeaveYearDto,
    actor: Actor,
    organizationId: string,
  ) {
    if (actor.role !== Role.ADMIN) {
      throw new BadRequestException('Only an Admin can change the leave year.');
    }
    const oldCfg = await getLeaveYearConfig(this.scopedPrisma, organizationId);
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    if (!org) throw new NotFoundException('Organization not found.');
    if (dto.startMonth === oldCfg.startMonth) {
      throw new BadRequestException(
        'The leave year already starts in that month.',
      );
    }
    const today = todayInOrgTz(org.timezone ?? 'Asia/Kolkata');
    const todayYear = Number(today.slice(0, 4));

    const [anyBalance, anyLeave] = await Promise.all([
      this.scopedPrisma.leaveBalance.count({ where: { organizationId } }),
      this.scopedPrisma.leave.count({ where: { organizationId } }),
    ]);
    const fresh = anyBalance === 0 && anyLeave === 0;
    if (!fresh && oldCfg.startMonth !== 1) {
      throw new BadRequestException(
        'The leave year has already been moved off the calendar year, and a second change would overlap the existing balance years. Contact support to change it again.',
      );
    }
    // New organisation: the setting simply applies from the start. Otherwise the calendar year in progress is extended.
    const newCfg: LeaveYearConfig = fresh
      ? {
          startMonth: dto.startMonth,
          anchorYear: dto.startMonth === 1 ? null : 2000,
        }
      : {
          startMonth: dto.startMonth,
          anchorYear: dto.startMonth === 1 ? null : todayYear + 1,
        };
    const extendedKey = fresh ? null : todayYear;

    // Leaves whose year(s) change: pending / approved ones touching the anchor year onward.
    const fromDate = newCfg.anchorYear
      ? `${newCfg.anchorYear}-01-01`
      : '0000-01-01';
    const leaves = fresh
      ? []
      : await this.scopedPrisma.leave.findMany({
          where: {
            organizationId,
            status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
            endDate: { gte: fromDate },
          },
          include: {
            leaveType: true,
            employee: { include: { department: true } },
          },
        });
    const holidays = await this.scopedPrisma.holiday.findMany({
      where: { organizationId, isActive: true, isOptional: false },
      select: { date: true, departmentId: true },
    });
    const orgPrefs = (
      await this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      })
    )?.attendancePayrollPrefs as OrganizationAttendancePrefs | null;

    type Move = {
      leave: (typeof leaves)[number];
      oldParts: { year: number; days: number }[];
      newParts: { year: number; days: number }[];
    };
    const moves: Move[] = [];
    for (const leave of leaves) {
      const oldSplit = leave.yearSplit as
        { year: number; days: number }[] | null;
      const oldParts =
        Array.isArray(oldSplit) && oldSplit.length > 0
          ? oldSplit
          : [
              {
                year: Number(leave.startDate.slice(0, 4)),
                days: leave.totalDays,
              },
            ];
      const rules = effectiveLeaveRules(
        leave.leaveType.rules as unknown as LeaveRules,
        leave.leaveType,
      );
      const holidayDates = new Set(
        holidays
          .filter(
            (h) =>
              h.departmentId === null ||
              h.departmentId === leave.employee.departmentId,
          )
          .map((h) => h.date),
      );
      const { weeklyOffs } = resolveShiftConfig(
        leave.employee.department,
        orgPrefs,
      );
      const newParts = splitDaysByYear(
        rules,
        leave.startDate,
        leave.endDate,
        leave.totalDays,
        holidayDates,
        weeklyOffs,
        newCfg,
      );
      const same =
        oldParts.length === newParts.length &&
        oldParts.every(
          (p, i) => p.year === newParts[i].year && p.days === newParts[i].days,
        );
      if (!same) moves.push({ leave, oldParts, newParts });
    }

    // Extended year top-up preview.
    const topUps: {
      employeeId: string;
      employeeCode: string;
      name: string;
      leaveType: string;
      from: number;
      to: number;
    }[] = [];
    const extended =
      extendedKey !== null ? this.describe(extendedKey, newCfg) : null;

    if (dto.dryRun) {
      if (extendedKey !== null) {
        await this.scopedPrisma.$transaction(
          async (tx) => {
            const types = await tx.leaveType.findMany({
              where: { organizationId, isActive: true },
            });
            for (const lt of types) {
              const r = await this.reconcileForYear(
                tx,
                lt,
                organizationId,
                extendedKey,
                newCfg,
                true,
              );
              topUps.push(...r.map((c) => ({ ...c, leaveType: lt.name })));
            }
          },
          { timeout: 60000 },
        );
      }
      return this.summary(
        true,
        oldCfg,
        newCfg,
        extended,
        moves.length,
        topUps,
        today,
      );
    }

    await this.scopedPrisma.$transaction(
      async (tx) => {
        await tx.organization.updateMany({
          where: { id: organizationId },
          data: {
            leaveYearStartMonth: newCfg.startMonth,
            leaveYearAnchorYear: newCfg.anchorYear,
          },
        });
        // Re-file each affected leave and move its days between the balance rows by the difference.
        for (const m of moves) {
          const lt = m.leave.leaveType;
          const ledger =
            lt.code !== LEAVE_TYPE_CODES.COMPOFF &&
            lt.allocationType !== AllocationType.NONE &&
            lt.allocationType !== AllocationType.UNLIMITED;
          if (ledger) {
            const delta = new Map<number, number>();
            for (const p of m.oldParts)
              delta.set(p.year, (delta.get(p.year) ?? 0) - p.days);
            for (const p of m.newParts)
              delta.set(p.year, (delta.get(p.year) ?? 0) + p.days);
            for (const [year, d] of delta) {
              if (d === 0) continue;
              const row = await this.leaveBalanceService.ensureBalanceRow(
                tx,
                m.leave.employeeId,
                m.leave.leaveTypeId,
                year,
                organizationId,
              );
              await tx.leaveBalance.updateMany({
                where: { id: row.id, organizationId },
                data:
                  m.leave.status === LeaveStatus.APPROVED
                    ? { availed: { increment: d } }
                    : { pending: { increment: d } },
              });
              await this.leaveBalanceService.recalculate(
                tx,
                row.id,
                organizationId,
              );
            }
          }
          await tx.leave.updateMany({
            where: { id: m.leave.id, organizationId },
            data: { yearSplit: m.newParts as unknown as Prisma.InputJsonValue },
          });
        }
        // Top the extended year's upfront credit up to its longer length.
        if (extendedKey !== null) {
          const types = await tx.leaveType.findMany({
            where: { organizationId, isActive: true },
          });
          for (const lt of types) {
            const r = await this.reconcileForYear(
              tx,
              lt,
              organizationId,
              extendedKey,
              newCfg,
              false,
            );
            topUps.push(...r.map((c) => ({ ...c, leaveType: lt.name })));
          }
        }
      },
      { timeout: 120000, maxWait: 20000 },
    );

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LEAVE_YEAR_CHANGED',
      module: 'LEAVE',
      organizationId,
      details: {
        fromStartMonth: oldCfg.startMonth,
        toStartMonth: newCfg.startMonth,
        anchorYear: newCfg.anchorYear,
        extendedYear: extended?.label ?? null,
        leavesRefiled: moves.length,
        balancesToppedUp: topUps.length,
      },
    });
    return this.summary(
      false,
      oldCfg,
      newCfg,
      extended,
      moves.length,
      topUps,
      today,
    );
  }

  // The extended year's rows for one leave type, set to the longer year's upfront credit (never below days already used).
  private async reconcileForYear(
    tx: Prisma.TransactionClient,
    leaveType: Parameters<LeaveBalanceService['reconcileUpfrontCredit']>[1],
    organizationId: string,
    year: number,
    cfg: LeaveYearConfig,
    dryRun: boolean,
  ) {
    const res = await this.leaveBalanceService.reconcileUpfrontCredit(
      tx,
      leaveType,
      organizationId,
      { dryRun, year, cfg },
    );
    return res.changes;
  }

  private summary(
    dryRun: boolean,
    oldCfg: LeaveYearConfig,
    newCfg: LeaveYearConfig,
    extended: ReturnType<LeaveYearService['describe']> | null,
    leavesRefiled: number,
    topUps: unknown[],
    today: string,
  ) {
    const key = currentLeaveYear(today, newCfg);
    return {
      dryRun,
      from: { startMonth: oldCfg.startMonth },
      to: { startMonth: newCfg.startMonth, anchorYear: newCfg.anchorYear },
      extendedYear: extended,
      nextYear:
        newCfg.anchorYear !== null && newCfg.startMonth !== 1
          ? this.describe(newCfg.anchorYear, newCfg)
          : null,
      currentYear: this.describe(key, newCfg),
      leavesRefiled,
      balancesToppedUp: topUps.length,
      topUps: topUps.slice(0, 200),
    };
  }
}

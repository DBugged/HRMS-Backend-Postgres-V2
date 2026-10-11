// Purpose: Periodic leave accrual - credits a PERIODIC leave type's quota to balances in instalments, nightly and on demand.
// Responsibilities: Works out which credits are due (leave-accrual.ts), applies the type's balance cap, and writes each credit
//   to the employee's balance row together with a ledger row (LeaveAccrualEntry) - in one transaction per employee and type.
// Important: idempotent. The ledger's unique key (employee, type, period start) means a period is credited once however
//   often this runs, retried or overlapped; a server that was down simply credits every missed period on the next run.
//   Only a PERIODIC type (and only for leave years from LeaveType.periodicFromYear) is touched; upfront types are not.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AllocationType,
  LeaveAccrualSource,
  LeaveAccrualMode,
  LeaveType,
  Prisma,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LeaveBalanceService } from './leave-balance.service';
import { isEligible } from './leave-eligibility';
import { getLeaveYearConfig } from './leave-year-config';
import {
  currentLeaveYear,
  LeaveYearConfig,
  leaveYearBounds,
} from './leave-year';
import {
  AccrualRule,
  annualEntitlement,
  dueCredits,
  nextCredit,
} from './leave-accrual';
import {
  isPeriodicForYear,
  shouldProrateOnJoining,
} from './leave-balance-math';
import { todayInOrgTz } from '../common/org-date';

const QUOTA_TYPES: AllocationType[] = [
  AllocationType.FIXED_ANNUAL,
  AllocationType.PRORATED_ON_JOINING,
  AllocationType.EARNED_MONTHLY,
];
const ACCRUAL_ROLES: Role[] = [
  Role.ADMIN,
  Role.HR,
  Role.MANAGER,
  Role.EMPLOYEE,
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AccrualRunItem {
  employeeId: string;
  employeeCode: string;
  name: string;
  leaveType: string;
  year: number;
  periodStart: string;
  periodEnd: string;
  days: number;
}

export interface AccrualRunResult {
  dryRun: boolean;
  asOf: string;
  credits: number;
  employees: number;
  totalDays: number;
  items: AccrualRunItem[];
}

export function ruleOfLeaveType(type: LeaveType): AccrualRule {
  return {
    annualQuota: type.annualQuota,
    accrualFrequency: type.accrualFrequency,
    accrualAmountPerCycle: type.accrualAmountPerCycle,
    accrueAt: type.accrueAt === 'START' ? 'START' : 'END',
    prorate: shouldProrateOnJoining(type),
  };
}

@Injectable()
export class LeaveAccrualService {
  private readonly logger = new Logger(LeaveAccrualService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // Every night, for every organisation. One organisation failing never stops the rest.
  @Cron('30 2 * * *')
  async nightlyAccrual() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      try {
        await this.run(org.id, { source: LeaveAccrualSource.SCHEDULED });
      } catch (err) {
        this.logger.error(
          `Leave accrual failed for org ${org.id}: ${err instanceof Error ? err.stack : String(err)}`,
        );
      }
    }
  }

  // Credits everything due as of today (or `asOf`, never later than today) for the organisation's PERIODIC leave types.
  async run(
    organizationId: string,
    opts: {
      dryRun?: boolean;
      leaveTypeId?: string;
      source: LeaveAccrualSource;
      actorId?: string;
    },
  ): Promise<AccrualRunResult> {
    const dryRun = opts.dryRun === true;
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const cfg = await getLeaveYearConfig(this.scopedPrisma, organizationId);
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const result: AccrualRunResult = {
      dryRun,
      asOf: today,
      credits: 0,
      employees: 0,
      totalDays: 0,
      items: [],
    };

    const types = await this.scopedPrisma.leaveType.findMany({
      where: {
        organizationId,
        isActive: true,
        accrualMode: LeaveAccrualMode.PERIODIC,
        allocationType: { in: QUOTA_TYPES },
        ...(opts.leaveTypeId ? { id: opts.leaveTypeId } : {}),
      },
    });
    if (types.length === 0) return result;

    // The year in progress, and the one before it during its first month (a last period that fell due while the server
    // was down is picked up).
    const currentKey = currentLeaveYear(today, cfg);
    const sinceStart = Math.round(
      (Date.parse(`${today}T00:00:00Z`) -
        Date.parse(`${leaveYearBounds(currentKey, cfg).start}T00:00:00Z`)) /
        86400000,
    );
    const keys = sinceStart <= 31 ? [currentKey - 1, currentKey] : [currentKey];

    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: ACCRUAL_ROLES } },
      select: {
        id: true,
        name: true,
        employeeId: true,
        joiningDate: true,
        departmentId: true,
        employeeType: true,
        gender: true,
      },
    });
    const touched = new Set<string>();

    for (const type of types) {
      for (const key of keys) {
        if (!isPeriodicForYear(type, key)) continue;
        const bounds = leaveYearBounds(key, cfg);
        const rule = ruleOfLeaveType(type);
        // Accrual runs regardless of the minimum service months: those gate APPLYING for the leave, not earning it.
        const applicable = employees.filter(
          (e) =>
            e.joiningDate.toISOString().slice(0, 10) <= bounds.end &&
            isEligible(
              {
                ...type,
                minServiceMonths: 0,
                maxServiceMonths: null,
              } as LeaveType,
              e,
            ),
        );
        if (applicable.length === 0) continue;

        const [entries, rows] = await Promise.all([
          this.scopedPrisma.leaveAccrualEntry.findMany({
            where: { organizationId, leaveTypeId: type.id, year: key },
            select: { employeeId: true, periodStart: true },
          }),
          this.scopedPrisma.leaveBalance.findMany({
            where: { organizationId, leaveTypeId: type.id, year: key },
          }),
        ]);
        const doneBy = new Map<string, Set<string>>();
        for (const e of entries) {
          const set = doneBy.get(e.employeeId) ?? new Set<string>();
          set.add(e.periodStart);
          doneBy.set(e.employeeId, set);
        }
        const rowBy = new Map(rows.map((r) => [r.employeeId, r]));

        for (const employee of applicable) {
          const dues = dueCredits(
            rule,
            bounds,
            employee.joiningDate.toISOString().slice(0, 10),
            today,
            doneBy.get(employee.id) ?? new Set(),
          );
          if (dues.length === 0) continue;
          let running = rowBy.get(employee.id)?.closing ?? 0;
          const planned: { due: (typeof dues)[number]; days: number }[] = [];
          for (const due of dues) {
            const room =
              type.maxBalance != null
                ? Math.max(0, type.maxBalance - running)
                : due.days;
            const days = round2(Math.min(due.days, room));
            if (days <= 0) continue;
            planned.push({ due, days });
            running += days;
          }
          if (planned.length === 0) continue;

          const applied: typeof planned = [];
          if (dryRun) {
            applied.push(...planned);
          } else {
            await this.scopedPrisma.$transaction(async (tx) => {
              const balance = await this.leaveBalanceService.ensureBalanceRow(
                tx,
                employee.id,
                type.id,
                key,
                organizationId,
              );
              for (const p of planned) {
                const { count } = await tx.leaveAccrualEntry.createMany({
                  data: [
                    {
                      organizationId,
                      employeeId: employee.id,
                      leaveTypeId: type.id,
                      year: key,
                      periodStart: p.due.period.start,
                      periodEnd: p.due.period.end,
                      days: p.days,
                      source: opts.source,
                      createdById: opts.actorId ?? null,
                    },
                  ],
                  skipDuplicates: true,
                });
                if (count === 0) continue;
                await tx.leaveBalance.updateMany({
                  where: { id: balance.id, organizationId },
                  data: { credited: { increment: p.days } },
                });
                applied.push(p);
              }
              if (applied.length > 0) {
                await this.leaveBalanceService.recalculate(
                  tx,
                  balance.id,
                  organizationId,
                );
              }
            });
          }
          for (const p of applied) {
            result.credits += 1;
            result.totalDays = round2(result.totalDays + p.days);
            touched.add(employee.id);
            if (result.items.length < 500) {
              result.items.push({
                employeeId: employee.id,
                employeeCode: employee.employeeId,
                name: employee.name,
                leaveType: type.name,
                year: key,
                periodStart: p.due.period.start,
                periodEnd: p.due.period.end,
                days: p.days,
              });
            }
          }
        }
      }
    }
    result.employees = touched.size;

    if (!dryRun && result.credits > 0) {
      const actorId =
        opts.actorId ??
        (
          await this.scopedPrisma.user.findFirst({
            where: { organizationId, isActive: true, role: Role.ADMIN },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        )?.id;
      if (actorId) {
        await this.auditLogService.log({
          actorId,
          action: 'LEAVE_ACCRUAL_RUN',
          module: 'LEAVE',
          organizationId,
          details: {
            source: opts.source,
            credits: result.credits,
            employees: result.employees,
            totalDaysCredited: result.totalDays,
            leaveTypes: types.map((t) => t.code),
          },
        });
      }
    }
    return result;
  }

  // What a balance card shows for a PERIODIC type: the yearly entitlement, the next credit and when it comes. Null for an
  // upfront type (or a year before the type went periodic).
  describeForBalance(
    type: LeaveType,
    joiningDate: Date,
    year: number,
    cfg: LeaveYearConfig,
    today: string,
  ) {
    if (
      type.accrualMode !== LeaveAccrualMode.PERIODIC ||
      !QUOTA_TYPES.includes(type.allocationType) ||
      !isPeriodicForYear(type, year)
    ) {
      return null;
    }
    const bounds = leaveYearBounds(year, cfg);
    const rule = ruleOfLeaveType(type);
    const joined = joiningDate.toISOString().slice(0, 10);
    const next = nextCredit(rule, bounds, joined, today);
    return {
      mode: 'PERIODIC' as const,
      frequency: type.accrualFrequency,
      accrueAt: rule.accrueAt,
      annualEntitlement: annualEntitlement(rule, bounds, joined),
      maxBalance: type.maxBalance ?? null,
      nextCredit: next ? { date: next.dueOn, days: next.days } : null,
    };
  }

  // The ledger for one employee and leave year.
  async history(
    employeeId: string,
    year: number | undefined,
    organizationId: string,
  ) {
    const rows = await this.scopedPrisma.leaveAccrualEntry.findMany({
      where: {
        organizationId,
        employeeId,
        ...(year !== undefined ? { year } : {}),
      },
      include: { leaveType: { select: { id: true, name: true, code: true } } },
      orderBy: [{ periodStart: 'desc' }],
      take: 500,
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        leaveType: r.leaveType,
        year: r.year,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        days: r.days,
        source: r.source,
        createdAt: r.createdAt,
      })),
    };
  }
}

export type { Prisma };

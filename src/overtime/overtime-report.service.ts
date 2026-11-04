// Purpose: The overtime report for Admin / HR: hours by department and by rule set for a month, each department's budget
//   against what has been used, and the people close to a monthly or quarterly limit.
// Responsibilities: reads overtime records for the month (and its quarter, for the quarterly limit), groups them, and keeps
//   each department's monthly overtime budget.
// Important: hours are those requested (pending) and approved; rejected requests are left out. "Weighted" hours multiply
//   each approved record by its pay multiplier. Cost is not shown: it depends on each person's salary and is final only
//   when payroll runs.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OvertimeStatus, PayrollRunStatus } from '@prisma/client';
import { estimateMonthlyBasic } from './basic-estimate';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { getOvertimePolicy, quarterRange } from './overtime-policy';
import { resolveCurrentRows } from '../employee-salary-components/salary-structure-math';
import { applyRuleSetPolicy, pickRuleSet } from './overtime-rule-sets';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class OvertimeReportService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditLogService,
  ) {}

  async report(month: number, year: number, organizationId: string) {
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      throw new BadRequestException('Choose a valid month and year.');
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const from = `${year}-${pad(month)}-01`;
    const to = `${year}-${pad(month)}-${pad(last)}`;
    const quarter = quarterRange(to);

    const [records, departments, sets, company] = await Promise.all([
      this.db.overtimeRecord.findMany({
        where: {
          organizationId,
          date: { gte: quarter.from, lte: quarter.to },
          status: { not: OvertimeStatus.REJECTED },
        },
        select: {
          date: true,
          hours: true,
          status: true,
          rateMultiplier: true,
          compensationKey: true,
          payDays: true,
          employee: {
            select: {
              id: true,
              name: true,
              employeeId: true,
              departmentId: true,
              employeeType: true,
              designation: true,
            },
          },
        },
      }),
      this.db.department.findMany({
        where: { organizationId },
        select: { id: true, name: true, overtimeBudgetHours: true },
        orderBy: { name: 'asc' },
      }),
      this.db.overtimeRuleSet.findMany({
        where: { organizationId, isActive: true },
      }),
      getOvertimePolicy(this.db, organizationId),
    ]);

    type Bucket = {
      people: Set<string>;
      approved: number;
      pending: number;
      weighted: number;
      cost: number;
    };
    const fresh = (): Bucket => ({
      people: new Set(),
      approved: 0,
      pending: 0,
      weighted: 0,
      cost: 0,
    });
    const add = (b: Bucket, r: (typeof records)[number]) => {
      b.people.add(r.employee.id);
      if (r.status === OvertimeStatus.APPROVED) {
        // Same maths as the standard Overtime Pay formula: hours x multiplier x (Basic / 208), plus pay days x (Basic / 30).
        // Work compensated with comp-off or days of pay is not paid by the hour.
        const paidHours = r.compensationKey ? 0 : r.hours * r.rateMultiplier;
        b.approved += r.hours;
        b.weighted += paidHours;
        const basic = basics.get(r.employee.id);
        if (basic === undefined) withoutBasic.add(r.employee.id);
        else b.cost += paidHours * (basic / 208) + r.payDays * (basic / 30);
      } else b.pending += r.hours;
    };
    // Each person's monthly Basic, for the cost estimate: from the salary structure (fixed, or a percentage of CTC or of
    // another fixed component), else the largest Basic on their last three payroll runs.
    const approvedIds = [
      ...new Set(
        records
          .filter(
            (r) =>
              r.status === OvertimeStatus.APPROVED &&
              r.date >= from &&
              r.date <= to,
          )
          .map((r) => r.employee.id),
      ),
    ];
    const basics = new Map<string, number>();
    if (approvedIds.length) {
      const [structureRows, runs] = await Promise.all([
        this.db.employeeSalaryComponent.findMany({
          where: {
            organizationId,
            employeeId: { in: approvedIds },
            isEnabled: true,
          },
        }),
        this.db.payrollRun.findMany({
          where: {
            organizationId,
            employeeId: { in: approvedIds },
            isFinalSettlement: false,
            runSequence: 0,
            status: { not: PayrollRunStatus.DRAFT },
          },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
          select: { employeeId: true, earnings: true, ctcMonthly: true },
          take: approvedIds.length * 3,
        }),
      ]);
      const rowsBy = new Map<string, typeof structureRows>();
      for (const r of structureRows) {
        rowsBy.set(r.employeeId, [...(rowsBy.get(r.employeeId) ?? []), r]);
      }
      // The latest run's monthly CTC, for a Basic set as a percentage of CTC.
      const ctcBy = new Map<string, number>();
      for (const run of runs) {
        if (!ctcBy.has(run.employeeId) && run.ctcMonthly > 0) {
          ctcBy.set(run.employeeId, run.ctcMonthly);
        }
      }
      const runBasics = new Map<string, number[]>();
      for (const run of runs) {
        const list = runBasics.get(run.employeeId) ?? [];
        if (list.length >= 3) continue;
        const entry = (
          (run.earnings ?? []) as unknown as { code: string; amount: number }[]
        ).find((e) => e.code === 'BASIC');
        list.push(Number(entry?.amount) || 0);
        runBasics.set(run.employeeId, list);
      }
      for (const id of approvedIds) {
        const estimate = estimateMonthlyBasic({
          rows: resolveCurrentRows(rowsBy.get(id) ?? [], to),
          ctcMonthly: ctcBy.get(id) ?? null,
          lastRunBasics: runBasics.get(id) ?? [],
        });
        if (estimate !== null) basics.set(id, estimate);
      }
    }
    const withoutBasic = new Set<string>();
    const byDept = new Map<string, Bucket>();
    const bySet = new Map<string, Bucket>();
    const person = new Map<
      string,
      {
        info: (typeof records)[number]['employee'];
        month: number;
        quarter: number;
      }
    >();

    for (const r of records) {
      const p = person.get(r.employee.id) ?? {
        info: r.employee,
        month: 0,
        quarter: 0,
      };
      p.quarter += r.hours;
      if (r.date >= from && r.date <= to) {
        p.month += r.hours;
        add(
          byDept.get(r.employee.departmentId ?? '') ??
            byDept
              .set(r.employee.departmentId ?? '', fresh())
              .get(r.employee.departmentId ?? '')!,
          r,
        );
        const set = pickRuleSet(sets, r.employee, r.date);
        const key = set?.id ?? 'company';
        add(bySet.get(key) ?? bySet.set(key, fresh()).get(key)!, r);
      }
      person.set(r.employee.id, p);
    }

    const nearCap: {
      employeeId: string;
      name: string;
      period: 'month' | 'quarter';
      used: number;
      limit: number;
      percent: number;
    }[] = [];
    for (const p of person.values()) {
      const policy = applyRuleSetPolicy(company, pickRuleSet(sets, p.info, to));
      const checks: ['month' | 'quarter', number | null, number][] = [
        ['month', policy.maxHoursPerMonth, p.month],
        ['quarter', policy.maxHoursPerQuarter, p.quarter],
      ];
      for (const [period, limit, used] of checks) {
        if (limit && used >= limit * 0.8) {
          nearCap.push({
            employeeId: p.info.employeeId,
            name: p.info.name,
            period,
            used: round2(used),
            limit,
            percent: Math.round((used / limit) * 100),
          });
        }
      }
    }
    nearCap.sort((a, b) => b.percent - a.percent);

    const out = (b: Bucket | undefined) => ({
      people: b?.people.size ?? 0,
      approvedHours: round2(b?.approved ?? 0),
      pendingHours: round2(b?.pending ?? 0),
      weightedHours: round2(b?.weighted ?? 0),
      estimatedCost: Math.round(b?.cost ?? 0),
    });
    const departmentRows = departments.map((d) => {
      const o = out(byDept.get(d.id));
      const used = o.approvedHours + o.pendingHours;
      return {
        id: d.id,
        name: d.name,
        ...o,
        budgetHours: d.overtimeBudgetHours,
        percentOfBudget: d.overtimeBudgetHours
          ? Math.round((used / d.overtimeBudgetHours) * 100)
          : null,
      };
    });
    const unassigned = out(byDept.get(''));
    if (unassigned.people)
      departmentRows.push({
        id: '',
        name: 'No department',
        ...unassigned,
        budgetHours: null,
        percentOfBudget: null,
      });
    const ruleSetRows = [
      { id: 'company', name: 'Company overtime', ...out(bySet.get('company')) },
      ...sets.map((s) => ({ id: s.id, name: s.name, ...out(bySet.get(s.id)) })),
    ];
    const totals = departmentRows.reduce(
      (a, d) => ({
        approvedHours: round2(a.approvedHours + d.approvedHours),
        pendingHours: round2(a.pendingHours + d.pendingHours),
        weightedHours: round2(a.weightedHours + d.weightedHours),
        estimatedCost: a.estimatedCost + d.estimatedCost,
      }),
      { approvedHours: 0, pendingHours: 0, weightedHours: 0, estimatedCost: 0 },
    );
    return {
      month,
      year,
      totals,
      peopleWithoutEstimate: withoutBasic.size,
      departments: departmentRows,
      ruleSets: ruleSetRows,
      nearCap,
    };
  }

  async setBudget(
    departmentId: string,
    hours: number | null,
    organizationId: string,
    actorId: string,
  ) {
    const dept = await this.db.department.findFirst({
      where: { id: departmentId, organizationId },
    });
    if (!dept) throw new NotFoundException('Department not found.');
    if (hours !== null && !(hours > 0 && hours <= 100000)) {
      throw new BadRequestException(
        'The budget must be more than 0 hours, or empty for none.',
      );
    }
    await this.db.department.updateMany({
      where: { id: departmentId, organizationId },
      data: { overtimeBudgetHours: hours },
    });
    await this.audit.log({
      actorId,
      action: 'OVERTIME_BUDGET_SET',
      module: 'ATTENDANCE',
      organizationId,
      targetId: departmentId,
      details: { hours },
    });
    return { departmentId, budgetHours: hours };
  }
}

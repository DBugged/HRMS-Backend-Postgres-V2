// Purpose: Builds the monthly EPFO ECR 2.0 upload file (and a pre-upload check) from locked payroll.
// Responsibilities: reads finalized PayrollRun snapshots (regular and final-settlement runs, merged to one line per
//   member), decrypts the UAN, resolves the PF wage ceiling in force, and hands the rows to buildEcr.
// Important: the PF wage base is the one payroll stored on each run, never recomputed here.
import { Inject, Injectable } from '@nestjs/common';
import { PayrollRunStatus } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { buildEcr, type EcrMemberInput } from './ecr-builder';

interface Line {
  code: string;
  amount: number;
  wages?: number;
  breakup?: { eps: number; epf: number };
}

const PAID_OUT: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];
// Settlement lines that are not wages for PF purposes.
const NON_WAGE_SETTLEMENT = new Set([
  'GRATUITY',
  'LEAVE_ENCASHMENT',
  'REIMBURSEMENT',
  'BONUS',
]);

const linesOf = (json: unknown): Line[] => (json as Line[] | null) ?? [];
const amountOf = (lines: unknown, code: string): number =>
  linesOf(lines).find((l) => l.code === code)?.amount ?? 0;

@Injectable()
export class EcrService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async build(
    month: number,
    year: number,
    organizationId: string,
    opts: { skipInvalid: boolean },
  ) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const asOf = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, month, year, status: { in: PAID_OUT } },
      orderBy: [{ isFinalSettlement: 'asc' }, { createdAt: 'asc' }],
    });
    // Only members who are on PF this month (a PF line, even a zero one for a full-LOP month).
    const pfRuns = runs.filter(
      (r) =>
        linesOf(r.deductions).some(
          (l) => l.code === SALARY_COMPONENT_CODES.PF,
        ) ||
        linesOf(r.employerContributions).some(
          (l) => l.code === SALARY_COMPONENT_CODES.PF_EMPLOYER,
        ),
    );

    const ids = [...new Set(pfRuns.map((r) => r.employeeId))];
    // Top-level read: the UAN is encrypted at rest and only this form of read decrypts it.
    const users = ids.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, id: { in: ids } },
          select: { id: true, name: true, personalData: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const merged = new Map<string, EcrMemberInput>();
    for (const r of pfRuns) {
      const u = userById.get(r.employeeId);
      const pd = (u?.personalData ?? {}) as Record<string, unknown>;
      const employerLine = linesOf(r.employerContributions).find(
        (l) => l.code === SALARY_COMPONENT_CODES.PF_EMPLOYER,
      );
      const employeePf = amountOf(r.deductions, SALARY_COMPONENT_CODES.PF);
      const att = (r.attendanceSummary ?? {}) as {
        lopDays?: number;
        unpaidLeaveDays?: number;
      };
      const gross = r.isFinalSettlement
        ? linesOf(r.earnings)
            .filter((l) => !NON_WAGE_SETTLEMENT.has(l.code))
            .reduce((s, l) => s + (l.amount || 0), 0)
        : r.grossSalary;
      const cur = merged.get(r.employeeId) ?? {
        uan: typeof pd.uanNumber === 'string' ? pd.uanNumber.trim() : '',
        name: u?.name ?? '',
        grossWages: 0,
        epfWages: 0,
        epfContribution: 0,
        epsContribution: 0,
        employerEpfShare: 0,
        ncpDays: 0,
      };
      cur.grossWages += gross;
      // Runs saved before wages were recorded: back out the base from the 12% employee share.
      cur.epfWages += employerLine?.wages ?? Math.round(employeePf / 0.12);
      cur.epfContribution += employeePf;
      cur.epsContribution += employerLine?.breakup?.eps ?? 0;
      cur.employerEpfShare += employerLine?.breakup?.epf ?? 0;
      cur.ncpDays += (att.lopDays ?? 0) + (att.unpaidLeaveDays ?? 0);
      merged.set(r.employeeId, cur);
    }

    const [version, settings, org] = await Promise.all([
      this.scopedPrisma.statutoryConfigVersion.findFirst({
        where: { organizationId, module: 'PF', effectiveFrom: { lte: asOf } },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.scopedPrisma.payrollSettings.findFirst({
        where: { organizationId },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { epfoEstablishmentCode: true },
      }),
    ]);
    const wageCeiling =
      (version?.config as { wageCeiling?: number } | undefined)?.wageCeiling ??
      settings?.pfWageCeiling ??
      15000;

    const result = buildEcr([...merged.values()], { wageCeiling, daysInMonth });
    const errors = result.issues.filter((i) => i.level === 'error');

    // The challan the same figures lead to (due on the 15th of the next month).
    const sumCode = (code: string) =>
      pfRuns.reduce((s, r) => s + amountOf(r.employerContributions, code), 0);
    const dueMonth = month === 12 ? 1 : month + 1;
    const dueYear = month === 12 ? year + 1 : year;
    const estCode = org?.epfoEstablishmentCode?.trim() || '';
    return {
      month,
      year,
      wageCeiling,
      fileName: `ECR_${(estCode || 'ESTABLISHMENT').replace(/[^A-Za-z0-9]/g, '')}_${String(month).padStart(2, '0')}${year}.txt`,
      establishmentCode: estCode,
      content: result.lines.join('\r\n'),
      members: merged.size,
      lines: result.lines.length,
      issues: result.issues,
      errors,
      ready: errors.length === 0 && result.lines.length > 0,
      totals: result.totals,
      challan: {
        dueDate: `${dueYear}-${String(dueMonth).padStart(2, '0')}-15`,
        epfAccount01: result.totals.epfContribution + result.totals.epfEpsDiff,
        epsAccount10: result.totals.epsContribution,
        edliAccount21: sumCode('EDLI_EMPLOYER'),
        adminAccount02: sumCode('EPF_ADMIN_EMPLOYER'),
        note: 'The EPFO administration charge has a minimum per establishment per month — confirm the payable amount on the portal.',
      },
      skipInvalid: opts.skipInvalid,
    };
  }
}

// Purpose: One short "pending approvals" email per approver on weekday mornings, instead of an email per request.
// Responsibilities: Counts requests still awaiting a decision (leave, attendance regularization, WFH, comp-off,
//   overtime, leave encashment, reimbursement, loan/advance), works out which counts each approver is responsible
//   for, and sends the APPROVALS_DIGEST template only to approvers who have something waiting.
// Important: Scope mirrors who can actually act — ADMIN/HR see the whole organization; anyone else who has direct
//   reports sees only those reports' requests, and only the request types a manager can decide (not finance/loan
//   types). An approver never counts their own requests. Respects the recipient's "email notifications" preference
//   and an org that has disabled the template (no email at all, unlike the generic fallback behaviour elsewhere).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { frontendUrl } from '../common/frontend-url';

const OCCASION_KEY = 'APPROVALS_DIGEST';

type CountKey =
  | 'leave'
  | 'regularization'
  | 'wfh'
  | 'compOff'
  | 'overtime'
  | 'encashment'
  | 'reimbursement'
  | 'loan';
type Counts = Record<CountKey, number>;

// Request types a non-HR manager can decide for their direct reports.
const MANAGER_KEYS: CountKey[] = [
  'leave',
  'regularization',
  'wfh',
  'compOff',
  'overtime',
];
const ALL_KEYS: CountKey[] = [
  ...MANAGER_KEYS,
  'encashment',
  'reimbursement',
  'loan',
];

const emptyCounts = (): Counts => ({
  leave: 0,
  regularization: 0,
  wfh: 0,
  compOff: 0,
  overtime: 0,
  encashment: 0,
  reimbursement: 0,
  loan: 0,
});

function emailEnabled(prefs: unknown): boolean {
  return (prefs as { emailEnabled?: boolean } | null)?.emailEnabled !== false;
}

@Injectable()
export class ApprovalsDigestService {
  private readonly logger = new Logger(ApprovalsDigestService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  // Weekdays only — no digest on weekends, and never more than one per approver per run.
  @Cron('0 9 * * 1-5')
  async sendDailyDigests() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      try {
        await this.sendDigestForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `Approvals digest failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async sendDigestForOrg(organizationId: string): Promise<number> {
    // An org that switched this template off gets no digest at all.
    const template = await this.scopedPrisma.emailTemplate.findFirst({
      where: { organizationId, occasionKey: OCCASION_KEY },
      select: { isActive: true },
    });
    if (template && !template.isActive) return 0;

    const perEmployee = await this.pendingCountsByEmployee(organizationId);
    if (perEmployee.size === 0) return 0;

    const users = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        reportingManagerId: true,
        notificationPreferences: true,
      },
    });
    const reportsByManager = new Map<string, string[]>();
    for (const u of users) {
      if (!u.reportingManagerId || u.reportingManagerId === u.id) continue;
      const list = reportsByManager.get(u.reportingManagerId) ?? [];
      list.push(u.id);
      reportsByManager.set(u.reportingManagerId, list);
    }

    let sent = 0;
    for (const approver of users) {
      if (!emailEnabled(approver.notificationPreferences)) continue;
      const isOrgWide =
        approver.role === Role.ADMIN || approver.role === Role.HR;
      const teamIds = reportsByManager.get(approver.id);
      if (!isOrgWide && !teamIds?.length) continue;

      const totals = emptyCounts();
      const keys = isOrgWide ? ALL_KEYS : MANAGER_KEYS;
      const scope = isOrgWide ? [...perEmployee.keys()] : teamIds!;
      for (const employeeId of scope) {
        if (employeeId === approver.id) continue; // never their own requests
        const counts = perEmployee.get(employeeId);
        if (!counts) continue;
        for (const k of keys) totals[k] += counts[k];
      }
      const totalPending = keys.reduce((s, k) => s + totals[k], 0);
      if (totalPending === 0) continue;

      // '' (not '0') hides that row in the template — see infoCard's optionalValue.
      const shown = (n: number) => (n > 0 ? String(n) : '');
      const variables = {
        employeeName: approver.name,
        totalPending: String(totalPending),
        leaveCount: shown(totals.leave),
        regularizationCount: shown(totals.regularization),
        wfhCount: shown(totals.wfh),
        compOffCount: shown(totals.compOff),
        overtimeCount: shown(totals.overtime),
        encashmentCount: shown(totals.encashment),
        reimbursementCount: shown(totals.reimbursement),
        loanCount: shown(totals.loan),
        reviewUrl: frontendUrl(),
      };
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        OCCASION_KEY,
        variables,
        this.emailTemplatesService.defaultFor(OCCASION_KEY, variables),
      );
      await this.emailService.send({
        organizationId,
        to: approver.email,
        subject: rendered.subject,
        html: rendered.html,
      });
      sent++;
    }
    return sent;
  }

  // employeeId -> how many requests of each type they currently have waiting.
  private async pendingCountsByEmployee(
    organizationId: string,
  ): Promise<Map<string, Counts>> {
    const p = this.scopedPrisma;
    const [
      leave,
      regularization,
      wfh,
      compOff,
      overtime,
      encashment,
      reimbursement,
      loan,
    ] = await Promise.all([
      p.leave.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
      p.attendance.groupBy({
        by: ['employeeId'],
        where: {
          organizationId,
          regularization: { path: ['status'], equals: 'pending' },
        },
        _count: { _all: true },
      }),
      p.attendance.groupBy({
        by: ['employeeId'],
        where: { organizationId, workArrangementStatus: 'PENDING' },
        _count: { _all: true },
      }),
      p.compOff.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
      p.overtimeRecord.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
      p.leaveEncashment.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
      p.reimbursement.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
      p.loan.groupBy({
        by: ['employeeId'],
        where: { organizationId, status: 'PENDING' },
        _count: { _all: true },
      }),
    ]);

    const map = new Map<string, Counts>();
    const add = (
      rows: { employeeId: string; _count: { _all: number } }[],
      key: CountKey,
    ) => {
      for (const r of rows) {
        const c = map.get(r.employeeId) ?? emptyCounts();
        c[key] += r._count._all;
        map.set(r.employeeId, c);
      }
    };
    add(leave, 'leave');
    add(regularization, 'regularization');
    add(wfh, 'wfh');
    add(compOff, 'compOff');
    add(overtime, 'overtime');
    add(encashment, 'encashment');
    add(reimbursement, 'reimbursement');
    add(loan, 'loan');
    return map;
  }
}

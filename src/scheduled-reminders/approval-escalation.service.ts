// Purpose: Escalates requests that have waited too long for a decision, so nothing stalls just because the first
// approver is away or forgot. (Auto-approval exists but is opt-in and only covers some request types.)
// Responsibilities: daily, finds PENDING requests whose age is a multiple of the threshold (default 3 days —
// APPROVAL_ESCALATION_DAYS, 0 turns the job off) and tells the next level up: the requester's skip-level manager
// (their manager's manager) when there is one, otherwise HR/Admin. HR-only request types (reimbursement, loan,
// leave encashment, resignation) escalate to Admin, falling back to HR. One digest per recipient per day.
// Important: re-escalates every threshold-days after the first time (3, 6, 9 days...) by deriving it from the
// request's age, so no escalation marker is stored. Nobody is ever escalated their own request.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  CompOffStatus,
  LeaveEncashmentStatus,
  LeaveStatus,
  LoanStatus,
  NotificationCategory,
  OvertimeStatus,
  ReimbursementStatus,
  ResignationStatus,
  Role,
  WfhApprovalStatus,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { frontendUrl } from '../common/frontend-url';
import { ReminderNotifier, ReminderUser } from './reminder-notifier.service';
import { isEscalationDue } from './reminder-dates';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LISTED = 5;

type RequestKind =
  | 'LEAVE'
  | 'REGULARIZATION'
  | 'WFH'
  | 'OVERTIME'
  | 'COMP_OFF'
  | 'REIMBURSEMENT'
  | 'LOAN'
  | 'ENCASHMENT'
  | 'RESIGNATION';

// Request types the requester's manager normally decides; the rest are decided by HR/Admin.
const MANAGER_KINDS: ReadonlySet<RequestKind> = new Set([
  'LEAVE',
  'REGULARIZATION',
  'WFH',
  'OVERTIME',
  'COMP_OFF',
]);

interface PendingRequest {
  kind: RequestKind;
  requesterId: string;
  requesterName: string;
  summary: string;
  requestedAt: Date;
}

export function escalationThresholdDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.APPROVAL_ESCALATION_DAYS;
  if (raw === undefined || raw === '') return 3;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

@Injectable()
export class ApprovalEscalationService {
  private readonly logger = new Logger(ApprovalEscalationService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('30 9 * * *')
  async escalateDaily() {
    const threshold = escalationThresholdDays();
    if (threshold === 0) return;
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    const now = new Date();
    for (const org of organizations) {
      try {
        await this.escalateForOrg(org.id, threshold, now);
      } catch (err) {
        this.logger.error(
          `Approval escalation failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async escalateForOrg(
    organizationId: string,
    thresholdDays: number,
    now: Date = new Date(),
  ): Promise<number> {
    const due = (await this.pendingRequests(organizationId)).filter((r) =>
      isEscalationDue(
        Math.floor((now.getTime() - r.requestedAt.getTime()) / DAY_MS),
        thresholdDays,
      ),
    );
    if (due.length === 0) return 0;

    const users = await this.notifier.activeUsers(organizationId);
    const byId = new Map(users.map((u) => [u.id, u]));
    const hrAndAdmin = users.filter(
      (u) => u.role === Role.HR || u.role === Role.ADMIN,
    );
    const admins = users.filter((u) => u.role === Role.ADMIN);

    const perRecipient = new Map<
      string,
      { user: ReminderUser; items: PendingRequest[] }
    >();
    const assign = (user: ReminderUser, item: PendingRequest) => {
      if (user.id === item.requesterId) return; // never their own request
      const entry = perRecipient.get(user.id) ?? { user, items: [] };
      entry.items.push(item);
      perRecipient.set(user.id, entry);
    };
    for (const item of due) {
      const requester = byId.get(item.requesterId);
      if (MANAGER_KINDS.has(item.kind)) {
        const manager = requester?.reportingManagerId
          ? byId.get(requester.reportingManagerId)
          : undefined;
        const skipLevel = manager?.reportingManagerId
          ? byId.get(manager.reportingManagerId)
          : undefined;
        if (skipLevel) assign(skipLevel, item);
        else for (const u of hrAndAdmin) assign(u, item);
      } else {
        for (const u of admins.length > 0 ? admins : hrAndAdmin)
          assign(u, item);
      }
    }

    let sent = 0;
    const today = now.toISOString().slice(0, 10);
    for (const { user, items } of perRecipient.values()) {
      items.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
      const listed = items
        .slice(0, MAX_LISTED)
        .map((i) => `${i.requesterName}: ${i.summary}`);
      if (items.length > MAX_LISTED)
        listed.push(`and ${items.length - MAX_LISTED} more`);
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'APPROVAL_ESCALATION',
        variables: {
          employeeName: user.name,
          totalPending: String(items.length),
          thresholdDays: String(thresholdDays),
          oldestSummary: `${items[0].requesterName}: ${items[0].summary}`,
          requestList: listed.join('; '),
          reviewUrl: frontendUrl(),
        },
        // The date keeps each day's escalation distinct from the previous one for dedupe purposes.
        title: `Escalation: ${items.length} request(s) waiting ${thresholdDays}+ days (${today})`,
        message: listed.join('; '),
        category: NotificationCategory.GENERAL,
        dedupeWithinHours: 20,
      });
      if (delivered) sent++;
    }
    return sent;
  }

  private async pendingRequests(
    organizationId: string,
  ): Promise<PendingRequest[]> {
    const p = this.scopedPrisma;
    const who = { select: { id: true, name: true } };
    const base = { organizationId };
    const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
    const [
      leaves,
      regularizations,
      wfh,
      overtime,
      compOffs,
      reimbursements,
      loans,
      encashments,
      resignations,
    ] = await Promise.all([
      p.leave.findMany({
        where: { ...base, status: LeaveStatus.PENDING },
        include: { employee: who, leaveType: { select: { name: true } } },
      }),
      p.attendance.findMany({
        where: {
          ...base,
          regularization: { path: ['status'], equals: 'pending' },
        },
        include: { employee: who },
      }),
      p.attendance.findMany({
        where: { ...base, workArrangementStatus: WfhApprovalStatus.PENDING },
        include: { employee: who },
      }),
      p.overtimeRecord.findMany({
        where: { ...base, status: OvertimeStatus.PENDING },
        include: { employee: who },
      }),
      p.compOff.findMany({
        where: { ...base, status: CompOffStatus.PENDING },
        include: { employee: who },
      }),
      p.reimbursement.findMany({
        where: { ...base, status: ReimbursementStatus.PENDING },
        include: { employee: who },
      }),
      p.loan.findMany({
        where: { ...base, status: LoanStatus.PENDING },
        include: { employee: who },
      }),
      p.leaveEncashment.findMany({
        where: { ...base, status: LeaveEncashmentStatus.PENDING },
        include: { employee: who },
      }),
      p.resignation.findMany({
        where: { ...base, status: ResignationStatus.PENDING },
        include: { employee: who },
      }),
    ]);
    const out: PendingRequest[] = [];
    const add = (
      kind: RequestKind,
      e: { id: string; name: string },
      summary: string,
      requestedAt: Date,
    ) =>
      out.push({
        kind,
        requesterId: e.id,
        requesterName: e.name,
        summary,
        requestedAt,
      });
    for (const l of leaves)
      add(
        'LEAVE',
        l.employee,
        `${l.leaveType.name} (${days(l.totalDays)})`,
        l.createdAt,
      );
    for (const a of regularizations)
      add(
        'REGULARIZATION',
        a.employee,
        `Attendance regularization for ${a.date}`,
        a.updatedAt,
      );
    for (const a of wfh)
      add('WFH', a.employee, `Work From Home for ${a.date}`, a.updatedAt);
    for (const o of overtime)
      add('OVERTIME', o.employee, `Overtime (${o.hours}h)`, o.createdAt);
    for (const c of compOffs)
      add(
        'COMP_OFF',
        c.employee,
        `Comp-off (${days(c.daysEarned)})`,
        c.createdAt,
      );
    for (const r of reimbursements)
      add(
        'REIMBURSEMENT',
        r.employee,
        `Reimbursement (${r.amount})`,
        r.createdAt,
      );
    for (const l of loans)
      add(
        'LOAN',
        l.employee,
        `${l.loanType === 'ADVANCE' ? 'Advance' : 'Loan'} (${l.principal})`,
        l.createdAt,
      );
    for (const e of encashments)
      add(
        'ENCASHMENT',
        e.employee,
        `Leave encashment (${days(e.days)})`,
        e.createdAt,
      );
    for (const r of resignations)
      add('RESIGNATION', r.employee, 'Resignation', r.createdAt);
    return out;
  }
}

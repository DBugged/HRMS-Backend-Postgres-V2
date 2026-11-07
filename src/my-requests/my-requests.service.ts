// Purpose: "My Requests" - everything the signed-in person has asked for, merged into one list with where each one stands, who it is
//   waiting with, a short timeline, and whether it can be withdrawn from here.
// Important: strictly the CALLER's own records (employeeId = caller.id, organizationId = caller's), whatever their role. A kind whose
//   module the company switched off is left out. Withdrawing reuses the existing rules for leave and attendance regularization; Work From Home
//   and loans can be withdrawn only while still pending; the other kinds cannot be withdrawn here.
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditModule, LoanStatus, WfhApprovalStatus, WorkArrangement, type Attendance, type Prisma, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { ModuleAccessService } from '../module-access/module-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LeavesService } from '../leaves/leaves.service';
import { AttendanceService } from '../attendance/attendance.service';
import { KIND_LABELS, KIND_MODULE, buildTimeline, namesLine, statusGroup, waitingDays, type RequestKind, type TimelineEvent } from './my-requests-logic';

type Caller = Omit<User, 'password'>;
const DAY = 86_400_000;
const nice = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const dayText = (d: string | Date) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10));
const range = (a: string, b: string) => (a === b ? a : `${a} to ${b}`);
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export interface MyRequestItem {
  id: string;
  kind: RequestKind;
  kindLabel: string;
  sourceId: string;
  title: string;
  detail: string;
  amount: string;
  note: string;
  status: string;
  group: string;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  waitingWith: string[];
  waitingDays: number | null;
  timeline: TimelineEvent[];
  canCancel: boolean;
  /** An approved leave that has not been taken yet: it cannot be withdrawn here, but the employee can ask for it to be cancelled on My Leave. */
  canRequestCancel?: boolean;
  link: string;
}

@Injectable()
export class MyRequestsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly moduleAccess: ModuleAccessService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
    private readonly leaves: LeavesService,
    private readonly attendance: AttendanceService,
  ) {}

  async list(caller: Caller) {
    const org = caller.organizationId;
    const me = caller.id;
    const off = await this.moduleAccess.disabledFor(org);
    const on = (k: RequestKind) => !off.has(KIND_MODULE[k]);
    const now = new Date();
    const from = new Date(now.getTime() - 90 * DAY).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 90 * DAY).toISOString().slice(0, 10);
    const take = 200;
    const [leaves, compOffs, claims, overtime, loans, regsRaw, wfhRaw] = await Promise.all([
      on('leave') ? this.prisma.leave.findMany({ where: { organizationId: org, employeeId: me }, include: { leaveType: { select: { name: true } }, reviewedBy: { select: { name: true } }, level1ApprovedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      on('comp_off') ? this.prisma.compOff.findMany({ where: { organizationId: org, employeeId: me }, include: { approvedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      on('reimbursement') ? this.prisma.reimbursement.findMany({ where: { organizationId: org, employeeId: me }, include: { approvedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      on('overtime') ? this.prisma.overtimeRecord.findMany({ where: { organizationId: org, employeeId: me }, include: { approvedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      on('loan') ? this.prisma.loan.findMany({ where: { organizationId: org, employeeId: me }, include: { approvedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      on('regularization') ? this.prisma.attendance.findMany({ where: { organizationId: org, employeeId: me, regularization: { path: ['requested'], equals: true } }, orderBy: { date: 'desc' }, take: 100 }) : [],
      on('wfh') ? this.prisma.attendance.findMany({ where: { organizationId: org, employeeId: me, workArrangement: WorkArrangement.WFH, workArrangementStatus: { not: WfhApprovalStatus.NONE }, date: { gte: from, lte: to } }, orderBy: { date: 'asc' }, take: 400 }) : [],
    ]);

    const regs = regsRaw as Attendance[];
    const wfh = wfhRaw as Attendance[];
    // Who is deciding, for everything still pending: the same people who were told about it.
    const requester = await this.prisma.user.findFirst({ where: { id: me, organizationId: org }, select: { id: true, reportingManagerId: true, additionalReportingManagerIds: true } });
    const reviewerNames = new Map<boolean, string[]>();
    const waitingFor = async (managerFirst: boolean) => {
      if (!reviewerNames.has(managerFirst)) {
        const ids = requester ? await this.notifications.reviewersFor(org, requester, managerFirst).catch(() => [] as string[]) : [];
        const users = ids.length ? await this.prisma.user.findMany({ where: { organizationId: org, id: { in: ids } }, select: { name: true } }) : [];
        reviewerNames.set(managerFirst, namesLine(users.map((u) => u.name)));
      }
      return reviewerNames.get(managerFirst)!;
    };
    // Regularization and WFH records keep the reviewer as an id: resolve those names in one go.
    const regReviewerIds = regs.map((a) => (a.regularization as { reviewedBy?: string | null } | null)?.reviewedBy).filter((x): x is string => typeof x === 'string' && x.length > 0);
    const wfhReviewerIds = wfh.map((r) => r.workArrangementReviewedById).filter((x): x is string => !!x);
    const nameRows = [...new Set([...regReviewerIds, ...wfhReviewerIds])];
    const reviewers = nameRows.length ? await this.prisma.user.findMany({ where: { organizationId: org, id: { in: nameRows } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(reviewers.map((u) => [u.id, u.name]));

    const items: MyRequestItem[] = [];
    const add = async (x: Omit<MyRequestItem, 'kindLabel' | 'group' | 'waitingDays' | 'timeline' | 'waitingWith' | 'submittedAt' | 'decidedAt'> & { managerFirst: boolean; firstApproval?: { by: string | null; at: Date | null } | null; submitted: Date; decided: Date | null }) => {
      const pending = statusGroup(x.status) === 'pending';
      const waitingWith = pending ? await waitingFor(x.managerFirst) : [];
      const { managerFirst: _m, firstApproval, submitted, decided, ...rest } = x;
      void _m;
      items.push({
        ...rest,
        kindLabel: KIND_LABELS[x.kind],
        group: statusGroup(x.status),
        waitingWith,
        waitingDays: pending ? waitingDays(submitted) : null,
        submittedAt: submitted.toISOString(),
        decidedAt: decided?.toISOString() ?? null,
        timeline: buildTimeline({ submittedAt: submitted, firstApproval, status: x.status, decidedBy: x.decidedBy, decidedAt: decided, note: x.note || null, waitingWith }),
      });
    };

    for (const l of leaves) {
      await add({
        id: `leave-${l.id}`, kind: 'leave', sourceId: l.id, title: `${l.leaveType?.name ?? 'Leave'}${l.isHalfDay ? ' (Half day)' : ''}`,
        detail: range(l.startDate, l.endDate), amount: days(Number(l.totalDays)), note: [l.remarks, l.reviewComments].filter(Boolean).join(' · '),
        status: l.status, decidedBy: l.reviewedBy?.name ?? null, canCancel: l.status === 'PENDING' || l.status === 'RETURNED', canRequestCancel: l.status === 'APPROVED' && !l.cancelRequestedAt && l.endDate >= now.toISOString().slice(0, 10), link: '/my/leaves',
        managerFirst: true, submitted: l.createdAt, decided: l.reviewedAt, firstApproval: l.level1ApprovedBy ? { by: l.level1ApprovedBy.name, at: l.level1ApprovedAt } : null,
      });
    }
    for (const c of compOffs) {
      await add({
        id: `comp_off-${c.id}`, kind: 'comp_off', sourceId: c.id, title: 'Comp-off', detail: `Worked ${c.earnedForDate}`, amount: `+${days(Number(c.daysEarned))}`,
        note: [c.reason, c.expiryDate ? `Expires ${c.expiryDate}` : '', c.decisionNote].filter(Boolean).join(' · '), status: c.status, decidedBy: c.approvedBy?.name ?? null,
        canCancel: false, link: '/my/comp-offs', managerFirst: true, submitted: c.createdAt, decided: c.approvedAt,
      });
    }
    for (const r of claims) {
      await add({
        id: `reimbursement-${r.id}`, kind: 'reimbursement', sourceId: r.id, title: `${nice(r.category)} claim`, detail: r.claimDate, amount: String(r.amount),
        note: [r.description, r.reviewComments].filter(Boolean).join(' · '), status: r.status, decidedBy: r.approvedBy?.name ?? null, canCancel: false,
        link: '/my/reimbursements', managerFirst: false, submitted: r.createdAt, decided: r.approvedDate ? new Date(r.approvedDate) : null,
      });
    }
    for (const o of overtime) {
      await add({
        id: `overtime-${o.id}`, kind: 'overtime', sourceId: o.id, title: `Overtime (${nice(String(o.type))})`, detail: o.date, amount: `${Number(o.hours)} h`,
        note: o.decisionNote ?? '', status: o.status, decidedBy: o.approvedBy?.name ?? null, canCancel: false, link: '/my/attendance',
        managerFirst: true, submitted: o.createdAt, decided: o.status === 'PENDING' ? null : o.updatedAt,
      });
    }
    for (const l of loans) {
      await add({
        id: `loan-${l.id}`, kind: 'loan', sourceId: l.id, title: `${nice(String(l.loanType))} request`, detail: `${l.tenureMonths} month${l.tenureMonths === 1 ? '' : 's'}`, amount: String(l.principal),
        note: [l.reason, l.decisionNote].filter(Boolean).join(' · '), status: l.status, decidedBy: l.approvedBy?.name ?? null, canCancel: l.status === LoanStatus.PENDING,
        link: '/my/loans', managerFirst: false, submitted: l.createdAt, decided: l.status === LoanStatus.PENDING ? null : l.updatedAt,
      });
    }
    for (const a of regs) {
      const g = a.regularization as { status?: string; reason?: string; reviewComments?: string; reviewedBy?: string | null; reviewedAt?: string | null };
      const status = (g.status || 'pending').toUpperCase();
      await add({
        id: `regularization-${a.id}`, kind: 'regularization', sourceId: a.id, title: 'Attendance regularization', detail: a.date, amount: '',
        note: [g.reason, status === 'REJECTED' ? g.reviewComments : ''].filter(Boolean).join(' · '), status, decidedBy: g.reviewedBy ? (nameOf.get(g.reviewedBy) ?? null) : null,
        canCancel: status === 'PENDING', link: '/my/attendance', managerFirst: true, submitted: a.updatedAt, decided: g.reviewedAt ? new Date(g.reviewedAt) : null,
      });
    }
    // Work From Home: the days of one multi-day request share a wfhRequestId and read as ONE request.
    const groups = new Map<string, typeof wfh>();
    for (const r of wfh) groups.set(r.wfhRequestId ?? `day-${r.id}`, [...(groups.get(r.wfhRequestId ?? `day-${r.id}`) ?? []), r]);
    for (const [key, ds] of groups) {
      ds.sort((a, b) => a.date.localeCompare(b.date));
      const approved = ds.filter((d) => d.workArrangementStatus === WfhApprovalStatus.APPROVED).length;
      const rejected = ds.filter((d) => d.workArrangementStatus === WfhApprovalStatus.REJECTED).length;
      const pending = ds.length - approved - rejected;
      const status = pending > 0 ? 'PENDING' : rejected === 0 ? 'APPROVED' : approved === 0 ? 'REJECTED' : 'APPROVED';
      const decidedRow = ds.find((d) => d.workArrangementReviewedAt);
      const note = ds.find((d) => d.workArrangementReviewComments)?.workArrangementReviewComments ?? '';
      await add({
        id: `wfh-${key}`, kind: 'wfh', sourceId: key, title: 'Work From Home', detail: range(dayText(ds[0].date), dayText(ds[ds.length - 1].date)), amount: days(ds.length),
        note: [ds.length > 1 && approved > 0 && rejected > 0 ? `${approved} approved, ${rejected} rejected` : '', note, ds[0].workArrangementReason ?? ''].filter(Boolean).join(' · '),
        status, decidedBy: decidedRow?.workArrangementReviewedById ? (nameOf.get(decidedRow.workArrangementReviewedById) ?? null) : null, canCancel: pending > 0,
        link: '/my/attendance', managerFirst: true, submitted: ds.map((d) => d.createdAt).sort((x, y) => x.getTime() - y.getTime())[0], decided: decidedRow?.workArrangementReviewedAt ?? null,
      });
    }

    items.sort((x, y) => y.submittedAt.localeCompare(x.submittedAt));
    const count = (g: string) => items.filter((i) => i.group === g).length;
    return { items, summary: { pending: count('pending'), approved: count('approved'), rejected: count('rejected'), past: count('past'), total: items.length } };
  }

  /** Withdraws one of the caller's own requests, where that is allowed. */
  async cancel(caller: Caller, kind: string, sourceId: string) {
    const org = caller.organizationId;
    switch (kind as RequestKind) {
      case 'leave':
        await this.leaves.cancel(sourceId, caller, org);
        break;
      case 'regularization':
        await this.attendance.cancelRegularization(sourceId, caller, org);
        break;
      case 'loan': {
        const { count } = await this.prisma.loan.updateMany({ where: { id: sourceId, organizationId: org, employeeId: caller.id, status: LoanStatus.PENDING }, data: { status: LoanStatus.CANCELLED, decisionNote: 'Withdrawn by the employee' } });
        if (!count) throw new ConflictException('This loan request is no longer pending, so it cannot be withdrawn.');
        await this.audit.log({ actorId: caller.id, action: 'LOAN_REQUEST_WITHDRAWN', module: AuditModule.PAYROLL, organizationId: org, targetId: sourceId });
        break;
      }
      case 'wfh': {
        const where: Prisma.AttendanceWhereInput = { organizationId: org, employeeId: caller.id, workArrangementStatus: WfhApprovalStatus.PENDING, ...(sourceId.startsWith('day-') ? { id: sourceId.slice(4) } : { wfhRequestId: sourceId }) };
        const { count } = await this.prisma.attendance.updateMany({ where, data: { workArrangement: WorkArrangement.OFFICE, workArrangementStatus: WfhApprovalStatus.NONE, wfhRequestId: null, workArrangementReason: null, workArrangementReviewComments: null } });
        if (!count) throw new ConflictException('This Work From Home request was just decided, so it cannot be withdrawn.');
        await this.audit.log({ actorId: caller.id, action: 'WFH_REQUEST_WITHDRAWN', module: AuditModule.ATTENDANCE, organizationId: org, targetId: sourceId, details: { days: count } });
        break;
      }
      default:
        throw new BadRequestException('This kind of request cannot be withdrawn here. Ask the person who approves it.');
    }
    return { ok: true };
  }
}

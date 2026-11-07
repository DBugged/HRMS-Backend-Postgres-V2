// Purpose: the pure rules behind "My Requests": which status group a request falls in, how long it has been waiting, and the
//   text of its timeline. No database access, so every rule is unit-tested directly.
export type RequestKind = 'leave' | 'comp_off' | 'reimbursement' | 'regularization' | 'wfh' | 'overtime' | 'loan';
export type StatusGroup = 'pending' | 'approved' | 'rejected' | 'past';

export const KIND_LABELS: Record<RequestKind, string> = {
  leave: 'Leave',
  comp_off: 'Comp-off',
  reimbursement: 'Claim',
  regularization: 'Attendance',
  wfh: 'Work from home',
  overtime: 'Overtime',
  loan: 'Loan',
};

/** Which module switch (Control Center) each kind belongs to; a company with it off gets none of that kind. */
export const KIND_MODULE: Record<RequestKind, string> = {
  leave: 'module.leave',
  comp_off: 'module.leave',
  reimbursement: 'module.loans_reimbursements',
  loan: 'module.loans_reimbursements',
  regularization: 'module.attendance',
  wfh: 'module.attendance',
  overtime: 'module.attendance',
};

export function statusGroup(status: string): StatusGroup {
  const s = (status || '').toLowerCase();
  if (s === 'pending' || s === 'returned') return 'pending';
  if (['approved', 'paid', 'availed', 'partially_availed', 'active', 'closed'].includes(s)) return 'approved';
  if (s === 'rejected') return 'rejected';
  return 'past';
}

/** Whole days since the request was sent (0 = today). */
export function waitingDays(submittedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - submittedAt.getTime()) / 86_400_000));
}

export interface TimelineEvent {
  label: string;
  at: string | null;
  by: string | null;
  note: string | null;
}

/** Submitted, optional first approval, then the decision (or "waiting"). */
export function buildTimeline(input: {
  submittedAt: Date;
  firstApproval?: { by: string | null; at: Date | null } | null;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  waitingWith: string[];
}): TimelineEvent[] {
  const out: TimelineEvent[] = [{ label: 'Submitted', at: input.submittedAt.toISOString(), by: null, note: null }];
  if (input.firstApproval?.by) out.push({ label: 'First approval', at: input.firstApproval.at?.toISOString() ?? null, by: input.firstApproval.by, note: null });
  const group = statusGroup(input.status);
  if (group === 'pending') {
    out.push({ label: input.waitingWith.length ? `Waiting for ${input.waitingWith.join(', ')}` : 'Waiting for a decision', at: null, by: null, note: null });
  } else {
    const word = group === 'approved' ? 'Approved' : group === 'rejected' ? 'Rejected' : input.status.charAt(0) + input.status.slice(1).toLowerCase().replace(/_/g, ' ');
    out.push({ label: word, at: input.decidedAt?.toISOString() ?? null, by: input.decidedBy, note: input.note });
  }
  return out;
}

/** Names for "waiting with": the first few, then a count. */
export function namesLine(names: string[], max = 3): string[] {
  if (names.length <= max) return names;
  return [...names.slice(0, max), `${names.length - max} more`];
}

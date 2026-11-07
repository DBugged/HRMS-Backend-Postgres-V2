// Purpose: the pure rules of Account Management (Company Admin): how a subscription reads as one of the seven statuses, when a
//   limit is "approaching" or "reached", and the fixed lists the forms and APIs share.
// Important: no database access here, so every rule is unit-tested directly.

export type SubscriptionStatusKey =
  | 'ACTIVE'
  | 'TRIAL'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'PAYMENT_PENDING'
  | 'SUSPENDED'
  | 'CANCELLED';

export const EXPIRING_SOON_DAYS = 30;

interface SubscriptionLike {
  status: string; // TRIALING | ACTIVE | PAST_DUE | CANCELED | EXPIRED
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

// What the company admin sees. A suspended company reads as Suspended whatever its subscription says; a trial or paid period whose
// end date has passed reads as Expired even if nobody has flipped the stored status yet.
export function deriveSubscriptionStatus(
  sub: SubscriptionLike | null,
  organizationStatus: string,
  now: Date = new Date(),
): SubscriptionStatusKey | null {
  if (organizationStatus === 'SUSPENDED') return 'SUSPENDED';
  if (!sub) return null;
  switch (sub.status) {
    case 'CANCELED':
      return 'CANCELLED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PAST_DUE':
      return 'PAYMENT_PENDING';
    case 'TRIALING':
      return sub.trialEndsAt && sub.trialEndsAt < now ? 'EXPIRED' : 'TRIAL';
    default: {
      const end = sub.currentPeriodEnd;
      if (!end) return 'ACTIVE';
      if (end < now) return 'EXPIRED';
      const days = (end.getTime() - now.getTime()) / 86_400_000;
      return days <= EXPIRING_SOON_DAYS ? 'EXPIRING_SOON' : 'ACTIVE';
    }
  }
}

export type LimitLevel = 'NO_LIMIT' | 'OK' | 'APPROACHING' | 'REACHED';

export const APPROACHING_AT = 0.8;

export function limitLevel(
  used: number,
  limit: number | null | undefined,
): LimitLevel {
  if (limit == null || !(limit > 0)) return 'NO_LIMIT';
  if (used >= limit) return 'REACHED';
  return used / limit >= APPROACHING_AT ? 'APPROACHING' : 'OK';
}

export const REQUEST_TYPES = [
  'PLAN_UPGRADE',
  'EXTRA_LICENCES',
  'ADD_ON',
  'MODULE_UPGRADE',
  'RENEWAL',
  'CANCELLATION',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const TICKET_CATEGORIES = [
  'GENERAL',
  'BILLING',
  'TECHNICAL',
  'FEATURE_REQUEST',
  'DATA',
  'OTHER',
] as const;

// The legacy status 'PENDING' (before the new list) reads as In Progress.
export const normalizeTicketStatus = (status: string): string =>
  status === 'PENDING' ? 'IN_PROGRESS' : status;

// A company admin can reopen or answer a ticket only while it is not closed.
export const TICKET_REPLY_BLOCKED = new Set(['CLOSED']);

export const EXPORT_ROW_CAP = 50_000;
export const EXPORT_LINK_HOURS = 24;
/** Every category in one Excel workbook, one sheet each (CSV is a single table, so All data is Excel only). */
export const EXPORT_ALL = 'ALL';
export const EXPORT_CATEGORIES = [
  { key: 'EMPLOYEES', label: 'Employees', dateRange: false },
  { key: 'ATTENDANCE', label: 'Attendance', dateRange: true },
  { key: 'LEAVE', label: 'Leave', dateRange: true },
  { key: 'PAYROLL', label: 'Payroll', dateRange: true },
  { key: 'SALARY_COMPONENTS', label: 'Salary components', dateRange: false },
  { key: 'LOANS', label: 'Loans', dateRange: false },
  { key: 'REIMBURSEMENTS', label: 'Reimbursements', dateRange: true },
  { key: 'DOCUMENTS', label: 'Document details', dateRange: false },
  { key: 'LEAVE_BALANCES', label: 'Leave balances', dateRange: false },
  { key: 'DEPARTMENTS', label: 'Departments', dateRange: false },
  { key: 'LOCATIONS', label: 'Locations & branches', dateRange: false },
  { key: 'HOLIDAYS', label: 'Holidays', dateRange: true },
  { key: 'ASSETS', label: 'Asset inventory', dateRange: false },
  { key: 'ASSET_ALLOCATIONS', label: 'Asset allocations', dateRange: false },
  { key: 'RESIGNATIONS', label: 'Resignations', dateRange: true },
  { key: 'SETTLEMENTS', label: 'Final settlements', dateRange: true },
  { key: 'OVERTIME', label: 'Overtime', dateRange: true },
  { key: 'COMP_OFFS', label: 'Comp-offs', dateRange: true },
] as const;
export const EXPORT_CATEGORIES_WITH_ALL = [{ key: 'ALL', label: 'All data (one Excel file)', dateRange: true }, ...EXPORT_CATEGORIES] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number]['key'];

export interface AccountNotice {
  level: 'danger' | 'warning' | 'info';
  code: string;
  text: string;
}
export interface OverdueInvoice {
  number: string;
  total: number;
  currency: string;
}
const dayLabel = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
export const TRIAL_WARNING_DAYS = 7;

/** The end date a notice counts down to: the trial end for a trial, otherwise the paid period end. */
export function endDateOf(sub: SubscriptionLike | null): Date | null {
  if (!sub) return null;
  return sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd;
}

/** What the company admin should be warned about right now (shown as banners on Subscription & Billing). */
export function accountNotices(
  status: SubscriptionStatusKey | null,
  end: Date | null,
  cancelAtPeriodEnd: boolean,
  overdue: OverdueInvoice[],
  now: Date = new Date(),
): AccountNotice[] {
  const out: AccountNotice[] = [];
  const days = end ? Math.ceil((end.getTime() - now.getTime()) / 86_400_000) : null;
  if (status === 'SUSPENDED') out.push({ level: 'danger', code: 'SUSPENDED', text: 'Your account is suspended. Please contact support to restore access.' });
  else if (status === 'EXPIRED') out.push({ level: 'danger', code: 'EXPIRED', text: `Your subscription ${end ? `expired on ${dayLabel(end)}` : 'has expired'}. Request a renewal to continue without interruption.` });
  else if (status === 'EXPIRING_SOON' && end && days != null) out.push({ level: 'warning', code: 'EXPIRING', text: `Your subscription renews or expires in ${days} day${days === 1 ? '' : 's'} (${dayLabel(end)}). Request a renewal if you want to continue.` });
  else if (status === 'TRIAL' && end && days != null && days <= TRIAL_WARNING_DAYS) out.push({ level: 'warning', code: 'TRIAL_ENDING', text: `Your trial ends in ${days} day${days === 1 ? '' : 's'} (${dayLabel(end)}). Request a plan to continue.` });
  if (overdue.length) {
    const total = overdue.reduce((a, i) => a + i.total, 0);
    out.push({ level: 'danger', code: 'OVERDUE', text: `${overdue.length} invoice${overdue.length === 1 ? ' is' : 's are'} overdue (${overdue[0].currency} ${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). Please arrange payment.` });
  }
  if (cancelAtPeriodEnd && end && status !== 'EXPIRED') out.push({ level: 'info', code: 'CANCELLING', text: `Your subscription is set to end on ${dayLabel(end)}.` });
  return out;
}

/** Which one-time reminder tier a subscription has reached: 30, 7 or 1 day before the end, or 0 once it has passed; null if none. */
export function reminderTier(end: Date | null, now: Date = new Date()): 30 | 7 | 1 | 0 | null {
  if (!end) return null;
  if (end < now) return 0;
  const days = (end.getTime() - now.getTime()) / 86_400_000;
  return days <= 1 ? 1 : days <= 7 ? 7 : days <= EXPIRING_SOON_DAYS ? 30 : null;
}

export interface PersonForTrend {
  joiningDate: Date;
  isActive: boolean;
  exitDate: string | null; // YYYY-MM-DD, the last working day once an exit is planned
  updatedAt: Date;
}

/**
 * Headcount at the end of each of the last `months` months (the current month ends today). A person counts from their joining date
 * until their last working day; someone now inactive with no recorded last day is counted until the day they were last updated
 * (the nearest date we have), so older months are an approximation.
 */
export function headcountTrend(people: PersonForTrend[], months: number, now: Date = new Date()): { month: string; headcount: number }[] {
  const out: { month: string; headcount: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const monthEnd = i === 0 ? now : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1) - 1);
    const count = people.filter((p) => {
      if (p.joiningDate > monthEnd) return false;
      if (p.isActive && !p.exitDate) return true;
      const left = p.exitDate ? new Date(`${p.exitDate}T23:59:59.999Z`) : p.isActive ? null : p.updatedAt;
      return left == null || left >= monthEnd;
    }).length;
    out.push({ month: `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`, headcount: count });
  }
  return out;
}

/** The day a schedule really runs in the month of `now`: a day the month does not have (30 or 31 in a short month, 29 in a common February) becomes the month's last day. */
export function effectiveDay(dayOfMonth: number, now: Date = new Date()): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(dayOfMonth, daysInMonth);
}

/** True when a monthly schedule should run now: its day has come this month and it has not already run this month. */
export function scheduleDue(dayOfMonth: number, lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (now.getUTCDate() < effectiveDay(dayOfMonth, now)) return false;
  if (!lastRunAt) return true;
  return lastRunAt.getUTCFullYear() !== now.getUTCFullYear() || lastRunAt.getUTCMonth() !== now.getUTCMonth();
}

/** Plain-language text for an audit action on the Account Activity page. */
export const ACTIVITY_LABELS: Record<string, string> = {
  ACCOUNT_REQUEST_CREATED: 'Sent a request',
  ACCOUNT_REQUEST_WITHDRAWN: 'Withdrew a request',
  ACCOUNT_DATA_EXPORT: 'Created a data export',
  ACCOUNT_DATA_EXPORT_DOWNLOADED: 'Downloaded a data export',
  ACCOUNT_EXPORT_SCHEDULE_SAVED: 'Saved a scheduled export',
  ACCOUNT_EXPORT_SCHEDULE_DELETED: 'Removed a scheduled export',
  ACCOUNT_EXPORT_RECIPIENT_CONFIRMED: 'An outside email address was confirmed',
  ACCOUNT_EXPORT_SCHEDULE_SENT: 'Scheduled export emailed',
  SUPPORT_TICKET_CREATED: 'Opened a support ticket',
  SUPPORT_TICKET_CLOSED: 'Closed a support ticket',
  SUPPORT_TICKET_REOPENED: 'Reopened a support ticket',
};

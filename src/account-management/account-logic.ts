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
export const EXPORT_CATEGORIES = [
  { key: 'EMPLOYEES', label: 'Employees', dateRange: false },
  { key: 'ATTENDANCE', label: 'Attendance', dateRange: true },
  { key: 'LEAVE', label: 'Leave', dateRange: true },
  { key: 'PAYROLL', label: 'Payroll', dateRange: true },
  { key: 'SALARY_COMPONENTS', label: 'Salary components', dateRange: false },
  { key: 'LOANS', label: 'Loans', dateRange: false },
  { key: 'REIMBURSEMENTS', label: 'Reimbursements', dateRange: true },
  { key: 'DOCUMENTS', label: 'Document details', dateRange: false },
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number]['key'];

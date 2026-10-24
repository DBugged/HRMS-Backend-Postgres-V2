// Purpose: small helpers shared by the Control Center services (paging, money, slugs).
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
/** The panel shows a slug; the HRMS table has none, so it is derived (id suffix keeps equal names distinct). */
export const orgSlug = (name: string, id: string) => `${slugify(name)}-${id.slice(0, 6)}`;
/** Prisma Decimal (or null) -> number for JSON. */
export const num = (d: { toString(): string } | null | undefined): number | null => (d == null ? null : Number(d.toString()));
export interface PageQuery { page?: string | number; pageSize?: string | number; q?: string; sort?: string }
export function paging(q: PageQuery) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  const [field, dir] = (q.sort ?? '').split(':');
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, field, dir: dir === 'asc' ? ('asc' as const) : ('desc' as const) };
}
export const TERM_MONTHS: Record<string, number> = { MONTHLY: 1, YEARLY: 12, FIVE_YEAR: 60, TEN_YEAR: 120 };
export const addMonths = (d: Date, m: number) => new Date(new Date(d).setMonth(d.getMonth() + m));

/**
 * What an organization owes per month on a plan: employees x rate, with employees above includedEmployees charged at
 * perExtraEmployeeRate. A yearly term uses limits.annualRate when the plan has one. Enterprise (no rate) is custom: null.
 */
export function monthlyCharge(
  plan: { perEmployeeRate: unknown; perExtraEmployeeRate: unknown; includedEmployees: number | null; limits: unknown },
  term: string,
  employees: number,
  customRate?: unknown,
): number | null {
  const limits = (plan.limits ?? {}) as { annualRate?: number };
  // A negotiated rate on the subscription beats the plan's own (it also covers employees above the cap).
  const custom = num(customRate as never);
  const rate = custom ?? (term === 'YEARLY' && limits.annualRate ? limits.annualRate : num(plan.perEmployeeRate as never));
  if (rate == null) return null;
  const cap = plan.includedEmployees ?? employees;
  const extraRate = custom ?? num(plan.perExtraEmployeeRate as never) ?? rate;
  const base = Math.min(employees, cap) * rate;
  return Math.round((base + Math.max(0, employees - cap) * extraRate) * 100) / 100;
}

/** How an organization's employee count sits against its plan's band, for the "over the plan's limit" warning. */
export function employeeLimit(plan: { includedEmployees: number | null; perExtraEmployeeRate: unknown }, employees: number, maxEmployees: number | null = null) {
  if (plan.includedEmployees == null && maxEmployees == null) return null;
  const included = plan.includedEmployees ?? maxEmployees!;
  // blockAt: the hard limit the Super Admin set on the subscription (HRMS refuses new employees beyond it); null = none.
  return { used: employees, included, overBy: Math.max(0, employees - included), hasOverageRate: plan.perExtraEmployeeRate != null, blockAt: maxEmployees };
}

/** A CSV/Excel cell that cannot run as a formula: text starting with = + - @ (or a tab / CR) gets a leading apostrophe. Numbers are left alone. */
export function csvSafe(v: unknown): string {
  const text = String(v ?? '');
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** The next invoice number for a month: one more than the highest suffix already used (counting rows is not safe once any are deleted). */
export function nextInvoiceNumber(prefix: string, highestExisting: string | null | undefined): string {
  const used = highestExisting && highestExisting.startsWith(prefix) ? Number(highestExisting.slice(prefix.length)) : 0;
  return `${prefix}${String((Number.isFinite(used) ? used : 0) + 1).padStart(4, '0')}`;
}

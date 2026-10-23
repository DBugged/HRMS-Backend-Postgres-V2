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
): number | null {
  const limits = (plan.limits ?? {}) as { annualRate?: number };
  const rate = term === 'YEARLY' && limits.annualRate ? limits.annualRate : num(plan.perEmployeeRate as never);
  if (rate == null) return null;
  const cap = plan.includedEmployees ?? employees;
  const extraRate = num(plan.perExtraEmployeeRate as never) ?? rate;
  const base = Math.min(employees, cap) * rate;
  return Math.round((base + Math.max(0, employees - cap) * extraRate) * 100) / 100;
}

// Purpose: Pure rules for company-performance-scaled variable pay — which percentage applies, and which
//   earlier "held" payouts are now due. Variable pay = Target x Company achievement % x Individual payout %.
// Important: Only used while PayrollSettings.companyPerformanceEnabled is on. A variable (non-monthly)
//   component is HELD in its normal payout month if no company % is entered for that financial year yet; it is
//   recorded on that run (heldVariablePay) and paid by the first later run once the % exists. Each paid line
//   carries its `cycleKey`, which is how a hold is known to be settled — and why a hold is never paid twice.

export interface HeldVariablePay {
  code: string;
  name: string;
  /** The payout month the amount belongs to, "YYYY-MM". */
  cycleKey: string;
  financialYear: string;
}

export interface CompanyPercentRow {
  departmentId: string | null;
  achievementPercent: number;
}

export interface RecentRun {
  month: number;
  year: number;
  earnings: unknown;
  heldVariablePay: unknown;
}

export const cycleKeyOf = (month: number, year: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

const monthIndex = (month: number, year: number): number =>
  year * 12 + (month - 1);

export function parseCycleKey(
  key: string,
): { month: number; year: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

// The employee's department row wins; otherwise the company-wide row (no
// department); otherwise nothing is entered yet (null → hold).
export function pickCompanyPercent(
  rows: CompanyPercentRow[],
  departmentId: string | null,
): { percent: number; scope: 'DEPARTMENT' | 'COMPANY' } | null {
  const dept = departmentId
    ? rows.find((r) => r.departmentId === departmentId)
    : undefined;
  if (dept) return { percent: dept.achievementPercent, scope: 'DEPARTMENT' };
  const company = rows.find((r) => r.departmentId === null);
  return company
    ? { percent: company.achievementPercent, scope: 'COMPANY' }
    : null;
}

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

// "code|cycleKey" of every variable payout already paid out by a run — a line
// stamped with the cycle it settles.
export function releasedKeys(runs: RecentRun[]): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    for (const line of asArray(run.earnings)) {
      if (typeof line.code === 'string' && typeof line.cycleKey === 'string') {
        out.add(`${line.code}|${line.cycleKey}`);
      }
    }
  }
  return out;
}

// Held payouts from runs BEFORE (month, year) that no run has paid yet.
export function pendingHolds(
  runs: RecentRun[],
  month: number,
  year: number,
  released: Set<string>,
): HeldVariablePay[] {
  const now = monthIndex(month, year);
  const seen = new Set<string>();
  const out: HeldVariablePay[] = [];
  for (const run of runs) {
    if (monthIndex(run.month, run.year) >= now) continue;
    for (const raw of asArray(run.heldVariablePay)) {
      const h = raw as unknown as HeldVariablePay;
      const key = `${h.code}|${h.cycleKey}`;
      if (!h.code || !h.cycleKey || released.has(key) || seen.has(key))
        continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out.sort((a, b) => a.cycleKey.localeCompare(b.cycleKey));
}

// How a scaled amount was worked out, for the payslip line.
export function describeVariablePay(
  target: number,
  companyPercent: number | null,
  individualPercent: number,
  scope: 'DEPARTMENT' | 'COMPANY' = 'COMPANY',
): string {
  const parts = [`${target}`];
  if (companyPercent !== null) {
    parts.push(
      `${companyPercent}% ${scope === 'DEPARTMENT' ? 'department' : 'company'}`,
    );
  }
  parts.push(`${individualPercent}% individual`);
  return parts.join(' × ');
}

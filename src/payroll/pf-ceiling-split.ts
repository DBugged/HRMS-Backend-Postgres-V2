// Purpose: Splits a month's PF wage ceiling when a PF statutory version changes part-way through it.
// Why: the ceiling rose from 15,000 to 25,000 on 17-Sep-2026 (S.O. 5109(E)); EPFO has the September contribution
// calculated separately for 1-16 (old ceiling) and 17-30 (new ceiling). Payroll resolves one version per month, so
// the whole of September was calculated at the new ceiling.
// Approach: the month's PF wages W are charged at each period's ceiling, weighted by that period's share of the
// month's calendar days: capped = sum(days_i / daysInMonth * min(W, ceiling_i)). That blended figure is used as the
// employee's effective ceiling for the month, so every PF line (employee, employer, EPS/EPF split, EDLI, admin) and
// the ECR wages stay consistent with each other. Assumption: the split is by calendar days, as in the EPFO example.
export interface PfVersionLike {
  effectiveFrom: string;
  effectiveTo: string | null;
  config: unknown;
}

export interface PfCeilingSegment {
  days: number;
  wageCeiling: number;
  edliMax: number;
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The PF versions in force on each day of the month, as consecutive segments. Returns a single segment (or none,
// when no version covers the month) when the ceiling does not change inside the month.
export function pfCeilingSegments(
  versions: PfVersionLike[],
  month: number,
  year: number,
): PfCeilingSegment[] {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const segments: (PfCeilingSegment & { key: string })[] = [];
  for (let day = 1; day <= total; day += 1) {
    const date = ymd(year, month, day);
    const version = versions
      .filter(
        (v) =>
          v.effectiveFrom <= date &&
          (v.effectiveTo === null || v.effectiveTo >= date),
      )
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const c = version?.config as
      | {
          wageCeiling?: number;
          edliRate?: number;
          edliMaxAmount?: number;
        }
      | undefined;
    if (!c || typeof c.wageCeiling !== 'number') continue;
    const edliMax =
      c.edliMaxAmount ??
      Math.round(((c.edliRate ?? 0.5) * c.wageCeiling) / 100);
    const key = `${c.wageCeiling}|${edliMax}`;
    const last = segments[segments.length - 1];
    if (last && last.key === key) last.days += 1;
    else segments.push({ key, days: 1, wageCeiling: c.wageCeiling, edliMax });
  }
  return segments.map(({ days, wageCeiling, edliMax }) => ({
    days,
    wageCeiling,
    edliMax,
  }));
}

// The employee's effective ceiling and EDLI cap for the month. Null when there is nothing to blend (one segment).
export function blendedPfCeiling(
  pfWages: number,
  segments: PfCeilingSegment[],
): { wageCeiling: number; edliMax: number } | null {
  if (segments.length < 2) return null;
  const total = segments.reduce((s, x) => s + x.days, 0);
  const wageCeiling = segments.reduce(
    (s, x) => s + (x.days / total) * Math.min(pfWages, x.wageCeiling),
    0,
  );
  const edliMax = segments.reduce(
    (s, x) => s + (x.days / total) * x.edliMax,
    0,
  );
  return { wageCeiling, edliMax };
}

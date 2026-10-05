// Purpose: Pure date/rule helpers for the scheduled reminder jobs (kept free of Nest/Prisma so they are unit-testable).
// Important: all dates are plain 'YYYY-MM-DD' strings, matching the rest of the codebase, and are handled in UTC so
// no server-timezone or DST shift can change a calendar date.

const DAY_MS = 24 * 60 * 60 * 1000;

const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD for the given year and 1-based month, with the day clamped to that month's length. */
export function dateOf(year: number, month: number, day: number): string {
  // Normalise month overflow (e.g. month 13 -> January of next year).
  const base = new Date(Date.UTC(year, month - 1, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(day, last))}`;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "October 2026" for a YYYY-MM-DD (or YYYY-MM) string. */
export function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Probation reminders go out this many days before the probation end date. */
export const PROBATION_REMINDER_DAYS: readonly number[] = [15, 7];

/** Payroll cut-off reminders go out this many days before the processing date. */
export const PAYROLL_CUTOFF_REMINDER_DAYS: readonly number[] = [3, 1];

/** Statutory due-date reminders go out this many days before the due date. */
export const STATUTORY_REMINDER_DAYS: readonly number[] = [5, 1];

/**
 * A request is escalated when it has waited `thresholdDays`, and again every `thresholdDays` after that
 * (3, 6, 9... days) — derived purely from its age so no "already escalated" marker has to be stored.
 * A threshold of 0 (or less) switches escalation off.
 */
export function isEscalationDue(
  ageDays: number,
  thresholdDays: number,
): boolean {
  if (!(thresholdDays > 0)) return false;
  return ageDays >= thresholdDays && ageDays % thresholdDays === 0;
}

export interface StatutoryDue {
  key: string;
  label: string;
  dueDate: string;
  period: string;
  daysLeft: number;
}

// Standard due dates (India / Maharashtra). They are reminders, not filings: the message tells HR to confirm the
// date for their registration category. Payment obligations are only reminded for modules the org has switched on.
//   PF / ESI      15th of the following month
//   TDS (salary)  7th of the following month
//   Form 24Q      31 Jul / 31 Oct / 31 Jan / 31 May (quarters ending Jun / Sep / Dec / Mar)
//   PT            last day of the following month
//   LWF (Mah.)    15 Jul (Jan-Jun) and 15 Jan (Jul-Dec)
export function upcomingStatutoryDues(
  today: string,
  enabledModules: ReadonlySet<string>,
  leadDays: readonly number[] = STATUTORY_REMINDER_DAYS,
): StatutoryDue[] {
  const [year, month] = today.split('-').map(Number);
  const candidates: Omit<StatutoryDue, 'daysLeft'>[] = [];

  // Monthly obligations: look at the due dates falling in the previous, current and next calendar month.
  for (let offset = -1; offset <= 2; offset++) {
    const dueMonth = month + offset;
    const periodMonth = dateOf(year, dueMonth - 1, 1); // the month the contribution is for
    const period = monthLabel(periodMonth);
    if (enabledModules.has('PF')) {
      candidates.push({
        key: 'PF',
        label: 'PF contribution and ECR',
        dueDate: dateOf(year, dueMonth, 15),
        period,
      });
    }
    if (enabledModules.has('ESI')) {
      candidates.push({
        key: 'ESI',
        label: 'ESI contribution',
        dueDate: dateOf(year, dueMonth, 15),
        period,
      });
    }
    if (enabledModules.has('PT')) {
      candidates.push({
        key: 'PT',
        label: 'Professional Tax payment',
        dueDate: dateOf(year, dueMonth + 1, 31), // clamped to the last day of the following month
        period: monthLabel(dateOf(year, dueMonth, 1)),
      });
    }
    candidates.push({
      key: 'TDS',
      label: 'TDS deposit (salary)',
      dueDate: dateOf(year, dueMonth, 7),
      period,
    });
  }

  // Quarterly TDS return (Form 24Q) and half-yearly LWF, for this and the adjoining years.
  for (const y of [year - 1, year, year + 1]) {
    candidates.push(
      {
        key: '24Q',
        label: 'TDS return (Form 24Q)',
        dueDate: `${y}-07-31`,
        period: `April to June ${y}`,
      },
      {
        key: '24Q',
        label: 'TDS return (Form 24Q)',
        dueDate: `${y}-10-31`,
        period: `July to September ${y}`,
      },
      {
        key: '24Q',
        label: 'TDS return (Form 24Q)',
        dueDate: `${y}-01-31`,
        period: `October to December ${y - 1}`,
      },
      {
        key: '24Q',
        label: 'TDS return (Form 24Q)',
        dueDate: `${y}-05-31`,
        period: `January to March ${y}`,
      },
    );
    if (enabledModules.has('LWF')) {
      candidates.push(
        {
          key: 'LWF',
          label: 'Labour Welfare Fund contribution',
          dueDate: `${y}-07-15`,
          period: `January to June ${y}`,
        },
        {
          key: 'LWF',
          label: 'Labour Welfare Fund contribution',
          dueDate: `${y}-01-15`,
          period: `July to December ${y - 1}`,
        },
      );
    }
  }

  const seen = new Set<string>();
  const result: StatutoryDue[] = [];
  for (const c of candidates) {
    const daysLeft = daysBetween(today, c.dueDate);
    if (!leadDays.includes(daysLeft)) continue;
    const id = `${c.key}|${c.dueDate}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ ...c, daysLeft });
  }
  return result.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

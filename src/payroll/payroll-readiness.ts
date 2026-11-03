// Purpose: The "before you run payroll" checklist for a month - what will stop a clean run, and what is just worth
//   knowing - so HR fixes the cause first instead of discovering it from a half-empty result.
// Responsibilities: from who is on payroll that month, decide who has no salary structure (the run would fail for
//   them), who has no usable bank details (they cannot be paid), who joined or leaves in the month (part-month pay).
// Important: pure; the service gathers the rows. Attendance gaps come from their own query and are added by the caller.

export interface ReadinessEmployee {
  id: string;
  name: string;
  code: string;
  joiningDate: string; // YYYY-MM-DD
  personalData: unknown;
}

export interface ReadinessPerson {
  id: string;
  name: string;
  code: string;
  detail?: string;
}

export type ReadinessLevel = 'blocker' | 'warning' | 'info';

export interface ReadinessCheck {
  key:
    | 'structure'
    | 'statutory'
    | 'opening'
    | 'bank'
    | 'pan'
    | 'approvals'
    | 'attendance'
    | 'joiners'
    | 'exits';
  level: ReadinessLevel;
  title: string;
  people: ReadinessPerson[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const person = (e: ReadinessEmployee, detail?: string): ReadinessPerson => ({
  id: e.id,
  name: e.name,
  code: e.code,
  ...(detail ? { detail } : {}),
});

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// "28 Sep" - fixed names, so the output never depends on the server's locale.
const shortDate = (iso: string): string =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export function buildReadiness(input: {
  month: number;
  year: number;
  employees: ReadinessEmployee[];
  /** Employees with a salary structure in force for the month. */
  withStructure: Set<string>;
  /** Last working days that fall in the month, by employee id. */
  exits: Map<string, string>;
  /** No PF/ESI/PT/LWF/gratuity/bonus in force for the month - payslips would carry only TDS. */
  statutoryOff?: boolean;
  /** Month the financial year starts (4 = April). */
  fyStartMonth?: number;
  /** Employees who already have year-to-date earnings/tax on record. */
  hasYtd?: Set<string>;
}): ReadinessCheck[] {
  const monthStart = `${input.year}-${String(input.month).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(input.year, input.month, 0))
    .toISOString()
    .slice(0, 10);

  // Someone who joins after the month is not on this month's payroll at all.
  const onPayroll = input.employees.filter((e) => e.joiningDate <= monthEnd);

  const noStructure = onPayroll.filter((e) => !input.withStructure.has(e.id));
  const noBank = onPayroll.filter((e) => {
    const pd = (e.personalData ?? {}) as Record<string, unknown>;
    return !text(pd.bankAccountNo) || !text(pd.bankIFSC);
  });
  // Payroll starting after the FY start month: anyone employed before this month with no year so far on record would
  // be taxed as if the year began now.
  const needsOpening =
    input.fyStartMonth !== undefined &&
    input.hasYtd !== undefined &&
    input.month !== input.fyStartMonth
      ? onPayroll.filter(
          (e) =>
            e.joiningDate < monthStart &&
            !input.hasYtd!.has(e.id) &&
            input.withStructure.has(e.id),
        )
      : [];
  // No PAN: tax is deducted at the higher rate, so it is worth fixing first (not a blocker).
  const noPan = onPayroll.filter((e) => !text(((e.personalData ?? {}) as Record<string, unknown>).panNumber));
  const joiners = onPayroll.filter(
    (e) => e.joiningDate >= monthStart && e.joiningDate <= monthEnd,
  );
  const leavers = onPayroll.filter((e) => input.exits.has(e.id));

  const checks: ReadinessCheck[] = [
    {
      key: 'structure',
      level: 'blocker',
      title: 'No salary structure',
      people: noStructure.map((e) => person(e)),
    },
    {
      key: 'statutory',
      level: 'warning',
      title: 'Statutory not set up',
      // Not about particular people; kept when payroll has anyone on it.
      people: [],
    },
    {
      key: 'opening',
      level: 'warning',
      title: 'Set opening balances (earnings and tax so far this year)',
      people: needsOpening.map((e) => person(e)),
    },
    {
      key: 'bank',
      level: 'warning',
      title: 'Bank details missing',
      people: noBank.map((e) => person(e)),
    },
    {
      key: 'pan',
      level: 'warning',
      title: 'PAN missing (tax is deducted at the higher rate)',
      people: noPan.map((e) => person(e)),
    },
    {
      key: 'joiners',
      level: 'info',
      title: 'Joined this month (part-month pay)',
      people: joiners.map((e) => person(e, shortDate(e.joiningDate))),
    },
    {
      key: 'exits',
      level: 'info',
      title: 'Leaving this month',
      people: leavers.map((e) =>
        person(e, `last day ${shortDate(input.exits.get(e.id)!)}`),
      ),
    },
  ];
  const statutory = input.statutoryOff && onPayroll.length > 0;
  return checks.filter((c) =>
    c.key === 'statutory' ? statutory : c.people.length > 0,
  );
}

// The one-line answer for HR: "go" (nothing to fix), "review" (warnings only - the run works but something is off) or
// "no-go" (a blocker: the run would fail or skip someone).
export type ReadinessVerdict = { status: 'go' | 'review' | 'no-go'; blockers: number; warnings: number; summary: string };

export function readinessVerdict(checks: ReadinessCheck[]): ReadinessVerdict {
  const blockers = checks.filter((c) => c.level === 'blocker').reduce((n, c) => n + Math.max(c.people.length, 1), 0);
  const warnings = checks.filter((c) => c.level === 'warning').reduce((n, c) => n + Math.max(c.people.length, 1), 0);
  const status = blockers > 0 ? 'no-go' : warnings > 0 ? 'review' : 'go';
  const summary =
    status === 'go'
      ? 'Ready to run - nothing needs fixing first.'
      : status === 'no-go'
        ? `Not ready: ${blockers} thing${blockers === 1 ? '' : 's'} would stop or skip the run${warnings ? `, plus ${warnings} to review` : ''}.`
        : `Can run, but ${warnings} thing${warnings === 1 ? '' : 's'} to review first.`;
  return { status, blockers, warnings, summary };
}

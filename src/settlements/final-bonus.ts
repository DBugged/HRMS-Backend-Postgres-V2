// Purpose: the statutory bonus owed at exit - the bonus for the accounting year up to the last working day, less what
//   the year's payroll already paid as bonus.
// Responsibilities: wraps computeStatutoryBonus (the annual-return arithmetic, unchanged) for a part year and does the
//   paid-already subtraction, kept pure so it is testable without a settlement fixture.
// Important: the rate and eligibility are the organisation's configured BONUS module; the allocable-surplus test and
//   any disqualification (dismissal for fraud, violence or misconduct causing loss) are the company's decision and are
//   not computed - HR flags a disqualification on the settlement.
import {
  computeStatutoryBonus,
  type BonusConfig,
  type BonusMonthInput,
} from '../payroll/statutory-bonus';

export interface FinalBonusResult {
  eligible: boolean;
  reason: string | null;
  // The bonus for the months worked in the accounting year.
  due: number;
  // Bonus already paid in the year (the payroll's BONUS lines).
  alreadyPaid: number;
  // What the settlement adds: due less already paid, never negative.
  payable: number;
}

export function finalStatutoryBonus(opts: {
  months: BonusMonthInput[];
  config: BonusConfig;
  alreadyPaid: number;
}): FinalBonusResult {
  const result = computeStatutoryBonus(opts.months, opts.config);
  const alreadyPaid = Math.max(0, Math.round(opts.alreadyPaid));
  const due = result.eligible ? result.bonus : 0;
  return {
    eligible: result.eligible,
    reason: result.reason,
    due,
    alreadyPaid,
    payable: Math.max(0, due - alreadyPaid),
  };
}

interface RunLike {
  month: number;
  year: number;
  earnings: unknown;
  attendanceSummary: unknown;
}

function linesOf(value: unknown): { code?: string; amount?: number }[] {
  return Array.isArray(value)
    ? (value as { code?: string; amount?: number }[])
    : [];
}

// One bonus-month input from a payroll run's (or a preview's) earnings and attendance summary.
export function bonusMonthFromRun(run: RunLike): BonusMonthInput {
  const att = (run.attendanceSummary ?? {}) as {
    payableDays?: number;
    totalDaysInMonth?: number;
  };
  return {
    month: run.month,
    year: run.year,
    basicDaEarned: linesOf(run.earnings)
      .filter((l) => l.code === 'BASIC' || l.code === 'DA')
      .reduce((sum, l) => sum + (l.amount || 0), 0),
    payableDays: att.payableDays ?? 0,
    totalDays:
      att.totalDaysInMonth ??
      new Date(Date.UTC(run.year, run.month, 0)).getUTCDate(),
  };
}

// Sum of the BONUS earning lines of the given runs.
export function bonusPaidIn(runs: { earnings: unknown }[]): number {
  return runs.reduce(
    (total, r) =>
      total +
      linesOf(r.earnings)
        .filter((l) => l.code === 'BONUS')
        .reduce((s, l) => s + (l.amount || 0), 0),
    0,
  );
}

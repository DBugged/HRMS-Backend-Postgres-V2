// Purpose: Who may change a tax regime, and when.
// Responsibilities: one decision per request - allowed (and whether it uses up the employee's one change) or refused with
//   a reason an employee can act on. Mirrors how payroll products such as Keka work: everyone starts on the New regime,
//   the company chooses whether employees may switch (and until which month), and HR/Admin can always set it.
// Important: pure. A choice made before the first payroll of the year is free (nothing has been withheld on it yet); after
//   that an employee gets ONE change a financial year. A salaried employee may still switch again in their income-tax
//   return - this only governs what the employer withholds.
import { TaxRegime } from '@prisma/client';

const MONTHS = [
  '',
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

export interface RegimeRuleContext {
  /** The regime on file (New when there is no declaration yet). */
  current: TaxRegime;
  requested: TaxRegime;
  /** HR / Admin acting on someone else: always allowed, never uses up the employee's change. */
  byHr: boolean;
  /** How many times the employee has already changed regime this year. */
  changesUsed: number;
  /** A payroll run exists for this employee in this financial year - the regime has started to be used. */
  payrollStarted: boolean;
  /** The financial year being edited is the current one. */
  isCurrentYear: boolean;
  /** Organisation setting: employees may switch regime themselves. */
  employeeChangeAllowed: boolean;
  /** Organisation setting: last calendar month (1-12) of the year in which they may; null = until the year ends. */
  cutoffMonth: number | null;
  /** First month of the financial year (4 = April). */
  fyStartMonth: number;
  /** The calendar month it is now (1-12). */
  currentMonth: number;
}

export type RegimeDecision =
  { ok: true; usesChange: boolean } | { ok: false; reason: string };

const indexInYear = (month: number, fyStartMonth: number) =>
  month >= fyStartMonth ? month - fyStartMonth : month + 12 - fyStartMonth;

export function decideRegimeChange(ctx: RegimeRuleContext): RegimeDecision {
  if (ctx.requested === ctx.current) return { ok: true, usesChange: false };
  if (ctx.byHr) return { ok: true, usesChange: false };

  if (!ctx.employeeChangeAllowed) {
    return {
      ok: false,
      reason:
        'Your company has asked HR to set tax regimes. Ask HR to change yours.',
    };
  }
  if (!ctx.isCurrentYear) {
    return {
      ok: false,
      reason:
        'The regime for a past year can no longer be changed here. Ask HR.',
    };
  }
  if (
    ctx.cutoffMonth !== null &&
    indexInYear(ctx.currentMonth, ctx.fyStartMonth) >
      indexInYear(ctx.cutoffMonth, ctx.fyStartMonth)
  ) {
    return {
      ok: false,
      reason: `The last month to change your tax regime was ${MONTHS[ctx.cutoffMonth]}. Ask HR if it still needs to change.`,
    };
  }
  // Before the first payroll nothing has been withheld on the regime, so choosing is free.
  if (!ctx.payrollStarted) return { ok: true, usesChange: false };
  if (ctx.changesUsed >= 1) {
    return {
      ok: false,
      reason:
        'You have already changed your tax regime this year. It can be changed once a year. Ask HR if it needs to change again.',
    };
  }
  return { ok: true, usesChange: true };
}

/** What the employee sees about changing regime, for the screen: can they, and if not, why. */
export function regimeChangeStatus(
  ctx: Omit<RegimeRuleContext, 'requested' | 'byHr'>,
): { canChange: boolean; reason: string | null; free: boolean } {
  const other = ctx.current === TaxRegime.NEW ? TaxRegime.OLD : TaxRegime.NEW;
  const decision = decideRegimeChange({
    ...ctx,
    requested: other,
    byHr: false,
  });
  return decision.ok
    ? { canChange: true, reason: null, free: !decision.usesChange }
    : { canChange: false, reason: decision.reason, free: false };
}

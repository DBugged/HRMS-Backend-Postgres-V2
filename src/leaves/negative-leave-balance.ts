// Purpose: What "Allow Negative Leave Balance" (Organization Settings > Policies) means for one leave application.
// Responsibilities: pure rules, no database - the negative-balance allowance of a balance row for each mode, and where to
//   cut a request in two when the days beyond the balance become Loss of Pay (LeavesService does the reads and writes).
// Important: with the switch off (the default) nothing here applies and leave never goes below zero.
import type { NegativeBalanceMode } from '../organizations/org-leave-switches';
import type { NegativeBalanceRule } from './leave-balance-check';
import { isPeriodicForYear } from '../leave-balances/leave-balance-math';
import {
  addDaysStr,
  countDaysInclusive,
  countWorkingDaysInclusive,
} from './leave-rules';
import type { WeeklyOffEntry } from '../attendance/attendance-shift-config';

/**
 * How far below zero a balance may go for a new request.
 * - off, or MARK_AS_LOP: not at all. Under MARK_AS_LOP the request is split first, so the part charged to the
 *   balance always fits and the rest is a separate Loss of Pay leave.
 * - UNLIMITED: no limit.
 * - UP_TO_YEAR_END: by what the leave type will still credit this leave year - the annual quota minus what has been
 *   credited so far, for a periodic (accrual) type; a type that is granted upfront has nothing left to credit, so 0.
 */
export function negativeBalanceRuleFor(
  switches: {
    allowNegativeLeaveBalance: boolean;
    negativeLeaveBalanceMode: NegativeBalanceMode;
  },
  leaveType: {
    accrualMode?: unknown;
    periodicFromYear?: number | null;
    annualQuota?: number | null;
  },
  row: { credited: number; year: number },
): NegativeBalanceRule {
  if (!switches.allowNegativeLeaveBalance) {
    return { allowed: false, maxNegativeDays: 0 };
  }
  if (switches.negativeLeaveBalanceMode === 'UNLIMITED') {
    return { allowed: true, maxNegativeDays: Number.MAX_SAFE_INTEGER };
  }
  if (switches.negativeLeaveBalanceMode === 'UP_TO_YEAR_END') {
    // Periodic only from the year the type was switched to it (earlier years were granted upfront).
    const remaining = isPeriodicForYear(
      leaveType as Parameters<typeof isPeriodicForYear>[0],
      row.year,
    )
      ? Math.max(0, (leaveType.annualQuota ?? 0) - row.credited)
      : 0;
    return { allowed: remaining > 0, maxNegativeDays: remaining };
  }
  return { allowed: false, maxNegativeDays: 0 };
}

export interface LossOfPaySplit {
  // The last date still charged to the leave type's own balance (null when none of the request fits).
  coveredEnd: string | null;
  // Days charged to the balance for [startDate, coveredEnd].
  coveredDays: number;
  // The first date of the Loss of Pay part, and its days (null / 0 when everything fits).
  lopStart: string | null;
  lopDays: number;
}

/**
 * Cuts [startDate, endDate] where the balance runs out. Days are counted the way the leave type counts them (calendar
 * days for a sandwich / calendar-day type, otherwise working days only), whole days only: the balance covers the
 * longest run of dates from the start whose charge is within `available`, and everything after is Loss of Pay.
 * A half day is not cut: it is covered only if at least half a day is available.
 */
export function splitForLossOfPay(args: {
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  totalDays: number;
  available: number;
  calendarDays: boolean;
  holidayDates: Set<string>;
  weeklyOffs: WeeklyOffEntry[];
}): LossOfPaySplit {
  const { startDate, endDate, isHalfDay, totalDays, available } = args;
  const free = Math.max(0, available);
  if (totalDays <= free + 1e-9) {
    return {
      coveredEnd: endDate,
      coveredDays: totalDays,
      lopStart: null,
      lopDays: 0,
    };
  }
  if (isHalfDay) {
    return {
      coveredEnd: null,
      coveredDays: 0,
      lopStart: startDate,
      lopDays: totalDays,
    };
  }
  const charge = (to: string) =>
    args.calendarDays
      ? countDaysInclusive(startDate, to)
      : countWorkingDaysInclusive(
          startDate,
          to,
          args.holidayDates,
          args.weeklyOffs,
        );
  const span = countDaysInclusive(startDate, endDate);
  let coveredEnd: string | null = null;
  let coveredDays = 0;
  for (let i = 0; i < span; i++) {
    const to = addDaysStr(startDate, i);
    const days = charge(to);
    if (days > free + 1e-9) break;
    coveredEnd = to;
    coveredDays = days;
  }
  // The covered run may end on weekly offs / holidays that cost nothing; the Loss of Pay part then starts on the first
  // date after them, which is the first one that is actually charged.
  if (coveredEnd === null || coveredDays === 0) {
    return {
      coveredEnd: null,
      coveredDays: 0,
      lopStart: startDate,
      lopDays: totalDays,
    };
  }
  const lopStart = addDaysStr(coveredEnd, 1);
  return {
    coveredEnd,
    coveredDays,
    lopStart,
    lopDays: Math.round((totalDays - coveredDays) * 100) / 100,
  };
}

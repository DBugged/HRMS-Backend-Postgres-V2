/**
 * Pure port of the old backend's `checkLeaveRules` (`leavePolicyEngine.js`).
 * Entirely data-driven off a LeaveType's `rules` JSON — no per-leave-type
 * branching. DB-dependent inputs (holiday dates, the employee's other
 * leaves) are pre-fetched once by LeavesService and passed in as plain
 * data, keeping this function itself DB-free and directly unit-testable.
 */
import {
  isWeeklyOff,
  WeeklyOffEntry,
} from '../attendance/attendance-shift-config';

export interface LeaveRules {
  minDurationDays: number;
  maxDurationDays: number | null;
  noticePeriodDays: number;
  allowBackdated: boolean;
  maxBackdateDays: number;
  allowFutureDated: boolean;
  maxAdvanceDays: number | null;
  allowHalfDay: boolean;
  sandwichLeaveApplies: boolean;
  // Event-based leave counted in calendar days: every date in the range is charged, weekends/holidays included.
  countCalendarDays?: boolean;
  restrictPrefixSuffixHoliday: boolean;
  maxConsecutiveDays: number | null;
  minGapBetweenRequestsDays: number;
}

/**
 * The rules that actually apply to an application of an event-based leave type. Several Leave Rules make no sense
 * for it and are hidden in the Leave Types form, so a stored value must not be enforced silently: the gap between
 * requests, the consecutive-day and advance-application limits (the entitlement per event is the limit), and, when
 * counted in calendar days, the sandwich / prefix-suffix holiday rules (every date is charged anyway). Any other
 * allocation type is returned unchanged.
 */
export function effectiveLeaveRules(
  rules: LeaveRules,
  leaveType: { allocationType: string; eventGrant?: unknown },
): LeaveRules {
  if (leaveType.allocationType !== 'EVENT_BASED') return rules;
  const calendarDays =
    (leaveType.eventGrant as { unit?: string } | null)?.unit !== 'WORKING_DAYS';
  return {
    ...rules,
    minGapBetweenRequestsDays: 0,
    maxConsecutiveDays: null,
    maxAdvanceDays: null,
    ...(calendarDays
      ? {
          countCalendarDays: true,
          sandwichLeaveApplies: false,
          restrictPrefixSuffixHoliday: false,
        }
      : {}),
  };
}

/**
 * Whether an application for this leave type has to carry a document. For an event-based type the supporting document
 * is collected (and checked by HR) when the grant is requested, so the application of dates does not ask for it again.
 */
export function applicationDocumentRule(leaveType: {
  allocationType: string;
  documentsRequired: boolean;
  documentRequiredAfterDays: number | null;
}): { documentsRequired: boolean; documentRequiredAfterDays: number | null } {
  if (leaveType.allocationType === 'EVENT_BASED') {
    return { documentsRequired: false, documentRequiredAfterDays: null };
  }
  return {
    documentsRequired: leaveType.documentsRequired,
    documentRequiredAfterDays: leaveType.documentRequiredAfterDays,
  };
}

export interface LeaveRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  isHalfDay: boolean;
  halfDaySession?: string | null;
  hasAttachment: boolean;
}

export interface DateRange {
  start: string;
  end: string;
  // A half-day leave on a single date, with the part of the day it covers. Two half-days of different sessions on the
  // same date do not overlap (see rangesOverlap).
  isHalfDay?: boolean;
  halfDaySession?: string | null;
}

export interface LeaveRuleContext {
  today: string; // YYYY-MM-DD
  holidayDates: Set<string>;
  // The employee's resolved weekly-offs (department shift config, falling
  // back to the org default) — used by the sandwich-leave gap check below
  // instead of assuming every org's weekend is plain Sunday.
  weeklyOffs: WeeklyOffEntry[];
  // Most recent approved/pending leave of the SAME type ending before
  // startDate — used for both sandwich-leave gap detection and
  // minGapBetweenRequestsDays.
  priorLeaveEndDate?: string | null;
  // All other pending/approved leaves of ANY type for this employee — the
  // unconditional overlap check applies regardless of rules.
  existingRanges: DateRange[];
  documentsRequired: boolean;
  documentRequiredAfterDays: number | null;
}

export interface LeaveRuleResult {
  ok: boolean;
  errors: string[];
  totalDays: number;
}

function toUTCDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function daysBetween(fromStr: string, toStr: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round(
    (toUTCDate(toStr).getTime() - toUTCDate(fromStr).getTime()) / MS_PER_DAY,
  );
}

function countDaysInclusive(startStr: string, endStr: string): number {
  return daysBetween(startStr, endStr) + 1;
}

// Working (non-weekly-off, non-holiday) days in [startStr, endStr],
// inclusive. Used when sandwichLeaveApplies is false so weekends/holidays
// falling inside a leave range aren't charged against the balance.
function countWorkingDaysInclusive(
  startStr: string,
  endStr: string,
  holidayDates: Set<string>,
  weeklyOffs: WeeklyOffEntry[],
): number {
  const span = countDaysInclusive(startStr, endStr);
  let working = 0;
  for (let i = 0; i < span; i++) {
    const d = addDaysStr(startStr, i);
    if (!isHolidayOrWeeklyOff(d, holidayDates, weeklyOffs)) working += 1;
  }
  return working;
}

function addDaysStr(dateStr: string, days: number): string {
  const date = toUTCDate(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isHolidayOrWeeklyOff(
  dateStr: string,
  holidayDates: Set<string>,
  weeklyOffs: WeeklyOffEntry[],
): boolean {
  if (holidayDates.has(dateStr)) return true;
  return isWeeklyOff(dateStr, weeklyOffs);
}

// If the gap between a prior same-type leave's end and this request's
// start is 1-3 days AND every gap day is a holiday/weekly-off, those gap
// days get folded into totalDays too (the employee didn't really get a
// break).
function computeSandwichAdjustedDays(
  totalDays: number,
  startDate: string,
  priorLeaveEndDate: string | null | undefined,
  holidayDates: Set<string>,
  weeklyOffs: WeeklyOffEntry[],
): number {
  if (!priorLeaveEndDate) return totalDays;
  const gapDays = daysBetween(priorLeaveEndDate, startDate) - 1;
  if (gapDays < 1 || gapDays > 3) return totalDays;

  const gapDates: string[] = [];
  for (let i = 1; i <= gapDays; i++) {
    gapDates.push(addDaysStr(priorLeaveEndDate, i));
  }
  const allNonWorking = gapDates.every((d) =>
    isHolidayOrWeeklyOff(d, holidayDates, weeklyOffs),
  );
  return allNonWorking ? totalDays + gapDays : totalDays;
}

// Exported so LeavesService can re-run the same check inside its create
// transaction, after acquiring a per-employee lock, against a freshly
// re-fetched range list — the check() call below only has a pre-transaction
// snapshot, which two concurrent apply() calls for the same employee can
// both pass (see LeavesService.createLeaveInternal for the full guard).
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  if (!(a.start <= b.end && b.start <= a.end)) return false;
  // The morning off under one leave and the afternoon under another is a legitimate day: two half-days on the same single
  // date, each with its own (different) session, do not clash. Anything else that shares a date does.
  const sameSingleDate =
    a.start === a.end && b.start === b.end && a.start === b.start;
  if (
    sameSingleDate &&
    a.isHalfDay &&
    b.isHalfDay &&
    a.halfDaySession &&
    b.halfDaySession &&
    a.halfDaySession !== b.halfDaySession
  ) {
    return false;
  }
  return true;
}

// The days a leave is charged, split by calendar year, so a leave spanning New Year takes its December days from the
// old year's balance and its January days from the new one's. `total` is what the whole request is charged (it can
// include a sandwich adjustment); each part is counted with the same basis as the total and the last part takes the
// remainder, so the parts always add up to it. A leave inside one year returns a single part.
export function splitDaysByYear(
  rules: Pick<LeaveRules, 'sandwichLeaveApplies' | 'countCalendarDays'>,
  startDate: string,
  endDate: string,
  total: number,
  holidayDates: Set<string>,
  weeklyOffs: WeeklyOffEntry[],
): { year: number; days: number }[] {
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  if (startYear === endYear) return [{ year: startYear, days: total }];
  const calendar = rules.sandwichLeaveApplies || rules.countCalendarDays;
  const parts: { year: number; days: number }[] = [];
  let assigned = 0;
  for (let year = startYear; year <= endYear; year += 1) {
    if (year === endYear) {
      parts.push({ year, days: Math.round((total - assigned) * 100) / 100 });
      break;
    }
    const from = year === startYear ? startDate : `${year}-01-01`;
    const to = `${year}-12-31`;
    const days = calendar
      ? countDaysInclusive(from, to)
      : countWorkingDaysInclusive(from, to, holidayDates, weeklyOffs);
    parts.push({ year, days });
    assigned += days;
  }
  return parts;
}

export function checkLeaveRules(
  rules: LeaveRules,
  request: LeaveRequest,
  context: LeaveRuleContext,
): LeaveRuleResult {
  const errors: string[] = [];

  // Shape checks before any day-count arithmetic — both of these produce a
  // totalDays that silently misrepresents the request otherwise.
  if (request.endDate < request.startDate) {
    // countDaysInclusive would return a negative day count, which then
    // slips past the balance check (a negative never exceeds available).
    errors.push('End date cannot be before start date.');
  } else if (request.isHalfDay && request.startDate !== request.endDate) {
    // A half day is by definition one date. Without this, the 0.5
    // short-circuit below charged 0.5 days for an arbitrarily long range
    // while attendance still wrote HALF_DAY across every date in it —
    // e.g. a month-long "half day" cost the employee half a day of balance.
    errors.push(
      'A half-day leave must start and end on the same date. Uncheck half day to apply for a date range.',
    );
  }

  // A half-day is leave from a working day. On a weekly off or holiday there is nothing to take leave from (a full-day
  // request made up only of such days is refused below for the same reason); event leave counted in calendar days
  // charges every date, so it is exempt.
  if (
    request.isHalfDay &&
    request.startDate === request.endDate &&
    !rules.countCalendarDays &&
    isHolidayOrWeeklyOff(
      request.startDate,
      context.holidayDates,
      context.weeklyOffs,
    )
  ) {
    errors.push(
      'The selected date is a weekly off or holiday - there is no working day to take half-day leave from.',
    );
  }

  const rangeIsValid = request.endDate >= request.startDate;
  // Day-count basis depends on sandwichLeaveApplies:
  //   - true  (traditional sandwich rule): every calendar day in the range
  //     is charged, weekends/holidays inside it included.
  //   - false (the seeded default): only working, non-holiday days inside
  //     the range are charged — a Fri->Mon request costs 2 days, not 4.
  // The half-day short-circuit and the gap-based sandwich adjustment
  // between separate requests (below) are independent of this.
  let totalDays: number;
  if (request.isHalfDay) {
    totalDays = 0.5;
  } else if (
    rules.sandwichLeaveApplies ||
    rules.countCalendarDays ||
    !rangeIsValid
  ) {
    totalDays = countDaysInclusive(request.startDate, request.endDate);
  } else {
    totalDays = countWorkingDaysInclusive(
      request.startDate,
      request.endDate,
      context.holidayDates,
      context.weeklyOffs,
    );
    if (totalDays === 0) {
      errors.push(
        'The selected dates fall entirely on weekly-offs/holidays — there are no working days to apply leave for.',
      );
    }
  }
  if (!request.isHalfDay && rules.sandwichLeaveApplies) {
    totalDays = computeSandwichAdjustedDays(
      totalDays,
      request.startDate,
      context.priorLeaveEndDate,
      context.holidayDates,
      context.weeklyOffs,
    );
  }

  if (totalDays < rules.minDurationDays) {
    errors.push(`Minimum leave duration is ${rules.minDurationDays} day(s).`);
  }
  if (rules.maxDurationDays !== null && totalDays > rules.maxDurationDays) {
    errors.push(`Maximum leave duration is ${rules.maxDurationDays} day(s).`);
  }
  if (
    rules.maxConsecutiveDays !== null &&
    totalDays > rules.maxConsecutiveDays
  ) {
    errors.push(
      `Maximum consecutive leave is ${rules.maxConsecutiveDays} day(s).`,
    );
  }

  const noticeDays = daysBetween(context.today, request.startDate);
  if (noticeDays < 0) {
    const backdateDays = Math.abs(noticeDays);
    if (!rules.allowBackdated) {
      errors.push(
        'Backdated leave requests are not allowed for this leave type.',
      );
    } else if (backdateDays > rules.maxBackdateDays) {
      errors.push(
        `Leave cannot be backdated more than ${rules.maxBackdateDays} day(s).`,
      );
    }
  } else {
    if (!rules.allowFutureDated && noticeDays > 0) {
      errors.push(
        'Future-dated leave requests are not allowed for this leave type.',
      );
    } else {
      if (noticeDays < rules.noticePeriodDays) {
        errors.push(
          `This leave type requires ${rules.noticePeriodDays} day(s) notice.`,
        );
      }
      if (rules.maxAdvanceDays !== null && noticeDays > rules.maxAdvanceDays) {
        errors.push(
          `Leave cannot be requested more than ${rules.maxAdvanceDays} day(s) in advance.`,
        );
      }
    }
  }

  if (request.isHalfDay && !rules.allowHalfDay) {
    errors.push('Half-day leave is not allowed for this leave type.');
  }

  if (rules.minGapBetweenRequestsDays > 0 && context.priorLeaveEndDate) {
    const gap = daysBetween(context.priorLeaveEndDate, request.startDate) - 1;
    if (gap < rules.minGapBetweenRequestsDays) {
      errors.push(
        `A minimum gap of ${rules.minGapBetweenRequestsDays} day(s) is required between leave requests of this type.`,
      );
    }
  }

  if (rules.restrictPrefixSuffixHoliday) {
    const dayBefore = addDaysStr(request.startDate, -1);
    const dayAfter = addDaysStr(request.endDate, 1);
    if (
      context.holidayDates.has(dayBefore) ||
      context.holidayDates.has(dayAfter)
    ) {
      errors.push(
        'Leave cannot be taken immediately before or after a holiday for this leave type.',
      );
    }
  }

  const documentThresholdCrossed =
    context.documentsRequired &&
    (context.documentRequiredAfterDays === null ||
      totalDays > context.documentRequiredAfterDays);
  if (documentThresholdCrossed && !request.hasAttachment) {
    errors.push('A supporting document is required for this leave request.');
  }

  // Unconditional — applies regardless of the leave type's rules.
  const overlapsExisting = context.existingRanges.some((range) =>
    rangesOverlap(range, {
      start: request.startDate,
      end: request.endDate,
      isHalfDay: request.isHalfDay,
      halfDaySession: request.halfDaySession ?? null,
    }),
  );
  if (overlapsExisting) {
    errors.push(
      'This leave request overlaps with an existing pending or approved leave.',
    );
  }

  return { ok: errors.length === 0, errors, totalDays };
}

/**
 * Pure port of the old backend's `checkLeaveRules` (`leavePolicyEngine.js`).
 * Entirely data-driven off a LeaveType's `rules` JSON — no per-leave-type
 * branching. DB-dependent inputs (holiday dates, the employee's other
 * leaves) are pre-fetched once by LeavesService and passed in as plain
 * data, keeping this function itself DB-free and directly unit-testable.
 */

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
  restrictPrefixSuffixHoliday: boolean;
  maxConsecutiveDays: number | null;
  minGapBetweenRequestsDays: number;
}

export interface LeaveRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  isHalfDay: boolean;
  hasAttachment: boolean;
}

export interface DateRange {
  start: string;
  end: string;
}

export interface LeaveRuleContext {
  today: string; // YYYY-MM-DD
  holidayDates: Set<string>;
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

function addDaysStr(dateStr: string, days: number): string {
  const date = toUTCDate(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isHolidayOrSunday(
  dateStr: string,
  holidayDates: Set<string>,
): boolean {
  if (holidayDates.has(dateStr)) return true;
  return toUTCDate(dateStr).getUTCDay() === 0; // Sunday only — hardcoded weekly-off, matches old system
}

// If the gap between a prior same-type leave's end and this request's
// start is 1-3 days AND every gap day is a holiday/Sunday, those gap days
// get folded into totalDays too (the employee didn't really get a break).
function computeSandwichAdjustedDays(
  totalDays: number,
  startDate: string,
  priorLeaveEndDate: string | null | undefined,
  holidayDates: Set<string>,
): number {
  if (!priorLeaveEndDate) return totalDays;
  const gapDays = daysBetween(priorLeaveEndDate, startDate) - 1;
  if (gapDays < 1 || gapDays > 3) return totalDays;

  const gapDates: string[] = [];
  for (let i = 1; i <= gapDays; i++) {
    gapDates.push(addDaysStr(priorLeaveEndDate, i));
  }
  const allNonWorking = gapDates.every((d) =>
    isHolidayOrSunday(d, holidayDates),
  );
  return allNonWorking ? totalDays + gapDays : totalDays;
}

function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function checkLeaveRules(
  rules: LeaveRules,
  request: LeaveRequest,
  context: LeaveRuleContext,
): LeaveRuleResult {
  const errors: string[] = [];

  let totalDays = request.isHalfDay
    ? 0.5
    : countDaysInclusive(request.startDate, request.endDate);
  if (!request.isHalfDay && rules.sandwichLeaveApplies) {
    totalDays = computeSandwichAdjustedDays(
      totalDays,
      request.startDate,
      context.priorLeaveEndDate,
      context.holidayDates,
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
    rangesOverlap(range, { start: request.startDate, end: request.endDate }),
  );
  if (overlapsExisting) {
    errors.push(
      'This leave request overlaps with an existing pending or approved leave.',
    );
  }

  return { ok: errors.length === 0, errors, totalDays };
}

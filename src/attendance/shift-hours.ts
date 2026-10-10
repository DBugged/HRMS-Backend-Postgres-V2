// Purpose: One definition of a shift's working time, shared by organization settings, departments and work schedules.
// Responsibilities: net working hours = (shift end - shift start, wrapping past midnight) - unpaid break, and the
//   consistency rules between shift times, break and the Present / Half-Day minimum hours.
// Important: pure and DB-free. The attendance engine already subtracts the break from the worked span before comparing
//   with the minimum hours, so a minimum above the net working hours could never be met by anyone.

const toMinutes = (t: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Start to end in minutes, wrapping past midnight (22:00 -> 06:00 = 480). Null when either time is not HH:mm.
export function shiftSpanMinutes(start: string, end: string): number | null {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return null;
  return (e - s + 24 * 60) % (24 * 60);
}

// Net working hours per day, to two decimals; null when the times are not valid.
export function netWorkingHours(
  start: string,
  end: string,
  breakMinutes: number,
): number | null {
  const span = shiftSpanMinutes(start, end);
  if (span === null) return null;
  return Math.round((Math.max(0, span - (breakMinutes || 0)) / 60) * 100) / 100;
}

export interface ShiftInputs {
  startTime: string;
  endTime: string;
  breakMinutes: number;
  minHoursForPresent?: number;
  minHoursForHalfDay?: number;
  crossesMidnight?: boolean;
}

// First problem found, as a user-facing sentence, or null when the combination is consistent.
export function shiftConsistencyError(i: ShiftInputs): string | null {
  const span = shiftSpanMinutes(i.startTime, i.endTime);
  if (span === null) return null; // the time format itself is validated elsewhere
  if (span === 0) return 'Shift start and end cannot be the same time.';
  const overnight = toMinutes(i.endTime)! < toMinutes(i.startTime)!;
  if (overnight && i.crossesMidnight === false) {
    return 'Shift end is before shift start - turn on "shift crosses midnight" or correct the times.';
  }
  if (!Number.isFinite(i.breakMinutes) || i.breakMinutes < 0) {
    return 'Break time is required (enter 0 if there is no break).';
  }
  if (i.breakMinutes >= span) {
    return `Break (${i.breakMinutes} min) must be shorter than the shift (${span} min).`;
  }
  const net = (span - i.breakMinutes) / 60;
  if (i.minHoursForPresent !== undefined && i.minHoursForPresent > net + 1e-9) {
    return `Minimum hours for Present (${i.minHoursForPresent}h) is more than the ${net}h of working time left after the break.`;
  }
  if (
    i.minHoursForPresent !== undefined &&
    i.minHoursForHalfDay !== undefined &&
    i.minHoursForHalfDay >= i.minHoursForPresent
  ) {
    return 'Minimum hours for Half Day must be less than the minimum hours for Present.';
  }
  return null;
}

// Purpose: pure date rules for scheduled reports - which period a run covers and whether a schedule is due now.
// Responsibilities: everything is worked out from the organization's own calendar day / weekday / hour, passed in, so
//   the rules can be tested without a clock and never depend on the server's timezone.
// Important: a run covers the period that has just ended (yesterday / the last 7 days / last month), never the one still
//   in progress, so a Monday-morning email is a complete week.
export type ScheduleFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface SchedulePeriod {
  from: string;
  to: string;
  // The last complete calendar month - what a month-based report (payroll variance) is about, whatever the frequency.
  month: number;
  year: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function periodFor(
  frequency: ScheduleFrequency,
  today: string,
): SchedulePeriod {
  const [y, m] = today.split('-').map(Number);
  const month = m === 1 ? 12 : m - 1;
  const year = m === 1 ? y - 1 : y;
  if (frequency === 'DAILY') {
    const day = shift(today, -1);
    return { from: day, to: day, month, year };
  }
  if (frequency === 'WEEKLY') {
    return { from: shift(today, -7), to: shift(today, -1), month, year };
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(last)}`,
    month,
    year,
  };
}

export interface DueInput {
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  sendHour: number;
  enabled: boolean;
  lastRunDate: string | null;
}

// `today` is the organization's calendar day, `hour` its current hour, `weekday` 0 (Sunday) - 6. A schedule is due in
// its hour or any later hour that day (so a job that was down at 08:00 still sends at 09:00), once per day.
export function isScheduleDue(
  s: DueInput,
  now: { today: string; hour: number; weekday: number },
): boolean {
  if (!s.enabled) return false;
  if (s.lastRunDate === now.today) return false;
  if (now.hour < s.sendHour) return false;
  if (s.frequency === 'DAILY') return true;
  if (s.frequency === 'WEEKLY') return s.dayOfWeek === now.weekday;
  if (s.frequency === 'MONTHLY') {
    return s.dayOfMonth === Number(now.today.slice(8, 10));
  }
  return false;
}

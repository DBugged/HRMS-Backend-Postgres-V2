import { OvertimeType } from '@prisma/client';
import {
  overtimeDayProblem,
  type OvertimeDayFacts,
} from './overtime-day-rules';

const base: OvertimeDayFacts = {
  type: OvertimeType.REGULAR,
  date: '2026-10-07',
  today: '2026-10-12',
  dayKind: 'WORKING',
  workedMinutes: 600,
  hours: 1,
  breakMinutes: 60,
};
const check = (o: Partial<OvertimeDayFacts>) =>
  overtimeDayProblem({ ...base, ...o });

describe('overtimeDayProblem', () => {
  it('accepts regular and night overtime on a worked weekday', () => {
    expect(check({})).toBeNull();
    expect(check({ type: OvertimeType.NIGHT })).toBeNull();
  });

  it('blocks a date that has not happened yet', () => {
    expect(check({ date: '2026-10-13' })).toMatch(/not happened yet/);
    expect(check({ date: '2026-10-12' })).toBeNull();
  });

  it('blocks weekend/holiday rate on an ordinary weekday', () => {
    expect(check({ type: OvertimeType.WEEKEND })).toMatch(
      /regular overtime, not weekend/,
    );
    expect(check({ type: OvertimeType.HOLIDAY })).toMatch(/not holiday/);
  });

  it('requires weekend type on a weekly off and holiday type on a holiday', () => {
    expect(
      check({ dayKind: 'WEEKLY_OFF', type: OvertimeType.WEEKEND }),
    ).toBeNull();
    expect(
      check({ dayKind: 'WEEKLY_OFF', type: OvertimeType.REGULAR }),
    ).toMatch(/weekend overtime/);
    expect(check({ dayKind: 'WEEKLY_OFF', type: OvertimeType.NIGHT })).toMatch(
      /weekend overtime/,
    );
    expect(
      check({ dayKind: 'HOLIDAY', type: OvertimeType.HOLIDAY }),
    ).toBeNull();
    expect(check({ dayKind: 'HOLIDAY', type: OvertimeType.WEEKEND })).toMatch(
      /holiday overtime/,
    );
  });

  it('needs punched time for the day', () => {
    expect(check({ workedMinutes: 0 })).toMatch(/regularized/);
  });

  it('caps hours at the time worked, less the break on a weekly off or holiday', () => {
    expect(check({ workedMinutes: 120, hours: 2 })).toBeNull();
    expect(check({ workedMinutes: 120, hours: 3 })).toMatch(/Only 2 hour/);
    expect(
      check({
        dayKind: 'WEEKLY_OFF',
        type: OvertimeType.WEEKEND,
        workedMinutes: 540,
        hours: 8,
      }),
    ).toBeNull();
    expect(
      check({
        dayKind: 'WEEKLY_OFF',
        type: OvertimeType.WEEKEND,
        workedMinutes: 540,
        hours: 9,
      }),
    ).toMatch(/Only 8 hour/);
  });
});

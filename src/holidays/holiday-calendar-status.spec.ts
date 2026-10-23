import { calendarLooksIncomplete, calendarStatus, inPrepWindow, isReminderDay } from './holiday-calendar-status';

describe('holiday calendar status', () => {
  it('prepares next year in November and December only', () => {
    expect([10, 11, 12, 1].map(inPrepWindow)).toEqual([false, true, true, false]);
  });
  it('is incomplete when empty or thinner than this year', () => {
    expect(calendarLooksIncomplete(0, 0)).toBe(true);
    expect(calendarLooksIncomplete(5, 12)).toBe(true);
    expect(calendarLooksIncomplete(12, 12)).toBe(false);
    expect(calendarLooksIncomplete(14, 12)).toBe(false);
  });
  it('is due only inside the window and only while incomplete', () => {
    expect(calendarStatus('2026-11-05', 3, 12)).toEqual({ nextYear: 2027, nextYearCount: 3, thisYearCount: 12, due: true });
    expect(calendarStatus('2026-11-05', 12, 12).due).toBe(false);
    expect(calendarStatus('2026-09-05', 0, 12).due).toBe(false);
    expect(calendarStatus('2026-12-31', 0, 12).nextYear).toBe(2027);
  });
  it('sends on 1 Nov, 1 Dec and 20 Dec only', () => {
    expect(['2026-11-01', '2026-12-01', '2026-12-20'].every(isReminderDay)).toBe(true);
    expect(['2026-11-02', '2026-10-01', '2026-12-25'].some(isReminderDay)).toBe(false);
  });
});

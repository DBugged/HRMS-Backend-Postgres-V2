import {
  CALENDAR_LEAVE_YEAR,
  currentLeaveYear,
  inBounds,
  leaveYearBounds,
  leaveYearLabel,
  leaveYearOf,
  monthsBeforeFirstCountedMonth,
  splitRangeByLeaveYear,
} from './leave-year';

// January -> April transition performed in 2026: the 2026 year is extended to 31 March 2027.
const APRIL = { startMonth: 4, anchorYear: 2027 };
// An organisation that started on an April year (no earlier history).
const APRIL_FROM_START = { startMonth: 4, anchorYear: 1900 };

describe('calendar leave year (the default)', () => {
  it("key is the date's own year and the bounds are 1 Jan - 31 Dec", () => {
    expect(leaveYearOf('2026-03-31', CALENDAR_LEAVE_YEAR)).toBe(2026);
    expect(leaveYearBounds(2026, CALENDAR_LEAVE_YEAR)).toEqual({
      start: '2026-01-01',
      end: '2026-12-31',
      months: 12,
    });
    expect(leaveYearLabel(2026, CALENDAR_LEAVE_YEAR)).toBe('2026');
  });
  it('start month 1 ignores any anchor', () => {
    expect(leaveYearOf('2027-02-01', { startMonth: 1, anchorYear: 2027 })).toBe(
      2027,
    );
  });
});

describe('April leave year after a transition in 2026', () => {
  it('dates before the anchor year keep the calendar year', () => {
    expect(leaveYearOf('2026-02-10', APRIL)).toBe(2026);
    expect(leaveYearOf('2026-12-31', APRIL)).toBe(2026);
  });
  it('Jan-Mar of the anchor year belong to the extended previous year', () => {
    expect(leaveYearOf('2027-01-01', APRIL)).toBe(2026);
    expect(leaveYearOf('2027-03-31', APRIL)).toBe(2026);
  });
  it('from April of the anchor year each year runs April - March', () => {
    expect(leaveYearOf('2027-04-01', APRIL)).toBe(2027);
    expect(leaveYearOf('2028-03-31', APRIL)).toBe(2027);
    expect(leaveYearOf('2028-04-01', APRIL)).toBe(2028);
  });
  it('bounds: 2026 is 15 months, 2027 is a normal April-March year', () => {
    expect(leaveYearBounds(2026, APRIL)).toEqual({
      start: '2026-01-01',
      end: '2027-03-31',
      months: 15,
    });
    expect(leaveYearBounds(2027, APRIL)).toEqual({
      start: '2027-04-01',
      end: '2028-03-31',
      months: 12,
    });
    expect(leaveYearBounds(2025, APRIL).months).toBe(12);
    expect(leaveYearBounds(2025, APRIL).end).toBe('2025-12-31');
  });
  it('labels', () => {
    expect(leaveYearLabel(2026, APRIL)).toBe('2026-27');
    expect(leaveYearLabel(2027, APRIL)).toBe('2027-28');
    expect(leaveYearLabel(2025, APRIL)).toBe('2025');
  });
  it("adjacent years tile the timeline: every date belongs to exactly one year's bounds", () => {
    for (const d of [
      '2026-12-31',
      '2027-01-01',
      '2027-03-31',
      '2027-04-01',
      '2028-03-31',
      '2028-04-01',
    ]) {
      const key = leaveYearOf(d, APRIL);
      expect(inBounds(d, leaveYearBounds(key, APRIL))).toBe(true);
      expect(inBounds(d, leaveYearBounds(key - 1, APRIL))).toBe(false);
      expect(inBounds(d, leaveYearBounds(key + 1, APRIL))).toBe(false);
    }
  });
});

describe('an organisation that has always had an April year', () => {
  it('maps and bounds consistently', () => {
    expect(leaveYearOf('2026-03-31', APRIL_FROM_START)).toBe(2025);
    expect(leaveYearOf('2026-04-01', APRIL_FROM_START)).toBe(2026);
    expect(leaveYearBounds(2025, APRIL_FROM_START)).toEqual({
      start: '2025-04-01',
      end: '2026-03-31',
      months: 12,
    });
  });
});

describe('currentLeaveYear', () => {
  it('uses the same mapping', () => {
    expect(currentLeaveYear('2027-02-14', APRIL)).toBe(2026);
    expect(currentLeaveYear('2027-04-14', APRIL)).toBe(2027);
  });
});

describe('monthsBeforeFirstCountedMonth (the 15th rule)', () => {
  const y = leaveYearBounds(2027, APRIL);
  it('joined before the year: nothing elapsed', () => {
    expect(monthsBeforeFirstCountedMonth('2026-11-20', y)).toBe(0);
  });
  it('joining on the 15th counts the joining month; the 16th starts next month', () => {
    expect(monthsBeforeFirstCountedMonth('2027-04-15', y)).toBe(0);
    expect(monthsBeforeFirstCountedMonth('2027-04-16', y)).toBe(1);
    expect(monthsBeforeFirstCountedMonth('2027-07-20', y)).toBe(4);
  });
  it('joining after the last month leaves nothing', () => {
    expect(monthsBeforeFirstCountedMonth('2028-03-20', y)).toBe(12);
  });
  it('in the 15-month extended year, counting runs from 1 January', () => {
    const ext = leaveYearBounds(2026, APRIL);
    expect(monthsBeforeFirstCountedMonth('2026-01-10', ext)).toBe(0);
    expect(monthsBeforeFirstCountedMonth('2027-02-20', ext)).toBe(14);
    expect(monthsBeforeFirstCountedMonth('2027-03-31', ext)).toBe(15);
  });
});

describe('splitRangeByLeaveYear', () => {
  it('a range inside one year is a single part', () => {
    expect(splitRangeByLeaveYear('2027-05-01', '2027-05-10', APRIL)).toEqual([
      { key: 2027, from: '2027-05-01', to: '2027-05-10' },
    ]);
  });
  it('a range across 31 March / 1 April splits there under an April year', () => {
    expect(splitRangeByLeaveYear('2028-03-30', '2028-04-02', APRIL)).toEqual([
      { key: 2027, from: '2028-03-30', to: '2028-03-31' },
      { key: 2028, from: '2028-04-01', to: '2028-04-02' },
    ]);
  });
  it('a range across 31 Dec does NOT split inside the extended year', () => {
    expect(splitRangeByLeaveYear('2026-12-30', '2027-01-02', APRIL)).toEqual([
      { key: 2026, from: '2026-12-30', to: '2027-01-02' },
    ]);
  });
  it('the calendar year still splits at New Year', () => {
    expect(
      splitRangeByLeaveYear('2026-12-30', '2027-01-02', CALENDAR_LEAVE_YEAR),
    ).toEqual([
      { key: 2026, from: '2026-12-30', to: '2026-12-31' },
      { key: 2027, from: '2027-01-01', to: '2027-01-02' },
    ]);
  });
});

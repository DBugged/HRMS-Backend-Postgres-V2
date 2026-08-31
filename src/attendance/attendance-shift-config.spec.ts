import {
  enumerateDateStrings,
  isWeeklyOff,
  resolveShiftConfig,
} from './attendance-shift-config';

describe('resolveShiftConfig', () => {
  const department = {
    shiftStartTime: '10:00',
    shiftEndTime: '19:00',
    lateInThresholdMinutes: 10,
    earlyOutThresholdMinutes: 20,
    minHoursForPresent: 7,
    minHoursForHalfDay: 3.5,
    weeklyOffs: [0, 6],
    breakMinutes: 30,
  };
  const orgPrefs = {
    defaultShiftStartTime: '09:00',
    defaultShiftEndTime: '17:00',
    defaultLateInThresholdMinutes: 5,
    defaultEarlyOutThresholdMinutes: 5,
    defaultMinHoursForPresent: 8,
    defaultMinHoursForHalfDay: 4,
    weekendDays: [0],
  };

  it('department fields win when a department is present', () => {
    expect(resolveShiftConfig(department, orgPrefs)).toEqual(department);
  });

  it('falls back to org prefs when no department', () => {
    expect(resolveShiftConfig(null, orgPrefs)).toEqual({
      shiftStartTime: '09:00',
      shiftEndTime: '17:00',
      lateInThresholdMinutes: 5,
      earlyOutThresholdMinutes: 5,
      minHoursForPresent: 8,
      minHoursForHalfDay: 4,
      weeklyOffs: [0],
      breakMinutes: 0,
    });
  });

  it('falls back to the hardcoded literal when neither department nor org prefs are usable', () => {
    expect(resolveShiftConfig(null, null)).toEqual({
      shiftStartTime: '09:30',
      shiftEndTime: '18:30',
      lateInThresholdMinutes: 15,
      earlyOutThresholdMinutes: 15,
      minHoursForPresent: 8,
      minHoursForHalfDay: 4,
      weeklyOffs: [0],
      breakMinutes: 0,
    });
  });

  it('falls back per-field when org prefs are partially populated', () => {
    const result = resolveShiftConfig(null, { defaultShiftStartTime: '08:00' });
    expect(result.shiftStartTime).toBe('08:00');
    expect(result.shiftEndTime).toBe('18:30');
  });

  it('falls back to 0 break minutes when org prefs have none set', () => {
    const result = resolveShiftConfig(null, { defaultShiftStartTime: '08:00' });
    expect(result.breakMinutes).toBe(0);
  });

  it('uses the org prefs break minutes when set', () => {
    const result = resolveShiftConfig(null, { ...orgPrefs, defaultBreakMinutes: 45 });
    expect(result.breakMinutes).toBe(45);
  });

  it('treats a malformed weeklyOffs JSON value as the hardcoded fallback', () => {
    const result = resolveShiftConfig(
      { ...department, weeklyOffs: 'not-an-array' },
      orgPrefs,
    );
    expect(result.weeklyOffs).toEqual([0]);
  });
});

describe('isWeeklyOff', () => {
  it('returns true when the date falls on a configured weekly-off day', () => {
    // 2026-08-16 is a Sunday.
    expect(isWeeklyOff('2026-08-16', [0])).toBe(true);
  });

  it('returns false when the date does not fall on a weekly-off day', () => {
    // 2026-08-17 is a Monday.
    expect(isWeeklyOff('2026-08-17', [0])).toBe(false);
  });

  it('supports multiple weekly-off days', () => {
    expect(isWeeklyOff('2026-08-16', [0, 6])).toBe(true); // Sunday
    expect(isWeeklyOff('2026-08-22', [0, 6])).toBe(true); // Saturday
  });

  // August 2026 Saturdays: 1st (1st), 8th (2nd), 15th (3rd), 22nd (4th),
  // 29th (5th) — same weekday for all five, only the occurrence differs.
  it('treats 2nd/4th Saturday as off and 1st/3rd/5th as worked', () => {
    const sundayOffAlternateSaturdays = [0, { day: 6, occurrences: [2, 4] }];
    expect(isWeeklyOff('2026-08-01', sundayOffAlternateSaturdays)).toBe(false); // 1st Sat
    expect(isWeeklyOff('2026-08-08', sundayOffAlternateSaturdays)).toBe(true); // 2nd Sat
    expect(isWeeklyOff('2026-08-15', sundayOffAlternateSaturdays)).toBe(false); // 3rd Sat
    expect(isWeeklyOff('2026-08-22', sundayOffAlternateSaturdays)).toBe(true); // 4th Sat
    expect(isWeeklyOff('2026-08-29', sundayOffAlternateSaturdays)).toBe(false); // 5th Sat
    expect(isWeeklyOff('2026-08-16', sundayOffAlternateSaturdays)).toBe(true); // Sunday still off every week
  });

  it('treats 1st/3rd/5th Saturday as off and 2nd/4th as worked', () => {
    const alt = [{ day: 6, occurrences: [1, 3, 5] }];
    expect(isWeeklyOff('2026-08-01', alt)).toBe(true); // 1st Sat
    expect(isWeeklyOff('2026-08-08', alt)).toBe(false); // 2nd Sat
    expect(isWeeklyOff('2026-08-15', alt)).toBe(true); // 3rd Sat
    expect(isWeeklyOff('2026-08-22', alt)).toBe(false); // 4th Sat
    expect(isWeeklyOff('2026-08-29', alt)).toBe(true); // 5th Sat
  });
});

describe('enumerateDateStrings', () => {
  it('returns a single-element array for a same-day range', () => {
    expect(enumerateDateStrings('2026-08-13', '2026-08-13')).toEqual([
      '2026-08-13',
    ]);
  });

  it('returns every inclusive date in a multi-day range', () => {
    expect(enumerateDateStrings('2026-08-13', '2026-08-16')).toEqual([
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('handles a month boundary correctly', () => {
    expect(enumerateDateStrings('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });
});

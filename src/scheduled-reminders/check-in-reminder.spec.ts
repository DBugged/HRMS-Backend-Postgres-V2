import {
  DEFAULT_CHECK_IN_REMINDER,
  isAfterEndMoment,
  isReminderMoment,
  minutesOfDay,
  resolveCheckInReminder,
  resolveCheckOutReminder,
  resolveStillCheckedInReminder,
  shiftTimeLabel,
} from './check-in-reminder';

describe('check-in reminder rules', () => {
  it('is on, 15 minutes before, unless the Admin says otherwise', () => {
    expect(resolveCheckInReminder(undefined)).toEqual(
      DEFAULT_CHECK_IN_REMINDER,
    );
    expect(resolveCheckInReminder({})).toEqual({
      enabled: true,
      minutesBefore: 15,
    });
    expect(
      resolveCheckInReminder({
        checkInReminder: { enabled: false, minutesBefore: 30 },
      }),
    ).toEqual({
      enabled: false,
      minutesBefore: 30,
    });
    // Out-of-range values are pulled into 5..120.
    expect(
      resolveCheckInReminder({ checkInReminder: { minutesBefore: 1 } })
        .minutesBefore,
    ).toBe(5);
    expect(
      resolveCheckInReminder({ checkInReminder: { minutesBefore: 999 } })
        .minutesBefore,
    ).toBe(120);
  });

  it('reads HH:mm as minutes after midnight', () => {
    expect(minutesOfDay('09:30')).toBe(570);
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('24:00')).toBeNull();
    expect(minutesOfDay(undefined)).toBeNull();
  });

  it('fires on exactly one 5-minute run per shift', () => {
    const start = minutesOfDay('09:30')!; // 570
    const runs = Array.from({ length: 12 }, (_, i) => 8 * 60 + 30 + i * 5); // 08:30 .. 09:25
    const hits = runs.filter((now) => isReminderMoment(start, now, 15));
    expect(hits).toEqual([9 * 60 + 15]); // 09:15 only
    // Another lead time.
    expect(runs.filter((now) => isReminderMoment(start, now, 30))).toEqual([
      9 * 60,
    ]);
    // Not after the shift has started.
    expect(isReminderMoment(start, start + 1, 15)).toBe(false);
  });

  it('labels the time in the organization 12 / 24 hour style', () => {
    expect(shiftTimeLabel('09:30', true)).toBe('9:30 AM');
    expect(shiftTimeLabel('00:15', true)).toBe('12:15 AM');
    expect(shiftTimeLabel('13:05', true)).toBe('1:05 PM');
    expect(shiftTimeLabel('09:30', false)).toBe('09:30');
  });

  it('the check-out reminder has its own switch and minutes, with the same defaults', () => {
    expect(resolveCheckOutReminder({})).toEqual({
      enabled: true,
      minutesBefore: 15,
    });
    const prefs = {
      checkInReminder: { enabled: false, minutesBefore: 10 },
      checkOutReminder: { enabled: true, minutesBefore: 30 },
    };
    expect(resolveCheckInReminder(prefs)).toEqual({
      enabled: false,
      minutesBefore: 10,
    });
    expect(resolveCheckOutReminder(prefs)).toEqual({
      enabled: true,
      minutesBefore: 30,
    });
    // Fires 15 minutes before an 18:30 end, on one 5-minute run.
    const end = minutesOfDay('18:30')!;
    expect(isReminderMoment(end, 18 * 60 + 15, 15)).toBe(true);
    expect(isReminderMoment(end, 18 * 60 + 20, 15)).toBe(false);
  });
});

describe('still checked in reminder rules', () => {
  it('is on, 30 minutes after the shift ends, unless the Admin says otherwise (5 to 240 minutes)', () => {
    expect(resolveStillCheckedInReminder(undefined)).toEqual({
      enabled: true,
      minutesAfter: 30,
    });
    expect(
      resolveStillCheckedInReminder({
        stillCheckedInReminder: { enabled: false, minutesAfter: 45 },
      }),
    ).toEqual({ enabled: false, minutesAfter: 45 });
    expect(
      resolveStillCheckedInReminder({
        stillCheckedInReminder: { minutesAfter: 1000 },
      }).minutesAfter,
    ).toBe(240);
  });

  it('fires on exactly one 5-minute run, N minutes after the end, also across midnight', () => {
    const end = 18 * 60; // 18:00
    expect(isAfterEndMoment(end, 18 * 60 + 30, 30)).toBe(true);
    expect(isAfterEndMoment(end, 18 * 60 + 26, 30)).toBe(true);
    expect(isAfterEndMoment(end, 18 * 60 + 25, 30)).toBe(false);
    expect(isAfterEndMoment(end, 18 * 60 + 31, 30)).toBe(false);
    expect(isAfterEndMoment(end, 17 * 60 + 30, 30)).toBe(false); // before the end
    expect(isAfterEndMoment(23 * 60 + 45, 15, 30)).toBe(true); // 23:45 end, 00:15 now
  });
});

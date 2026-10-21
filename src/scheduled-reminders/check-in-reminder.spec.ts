import {
  DEFAULT_CHECK_IN_REMINDER,
  isReminderMoment,
  minutesOfDay,
  resolveCheckInReminder,
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
});

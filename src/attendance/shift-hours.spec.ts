import {
  netWorkingHours,
  shiftConsistencyError,
  shiftSpanMinutes,
} from './shift-hours';

describe('shift hours', () => {
  it('computes span, wrapping past midnight', () => {
    expect(shiftSpanMinutes('09:30', '18:30')).toBe(540);
    expect(shiftSpanMinutes('22:00', '06:00')).toBe(480);
    expect(shiftSpanMinutes('9:30', '18:30')).toBeNull();
  });

  it('nets the break out of the shift', () => {
    expect(netWorkingHours('09:30', '18:30', 60)).toBe(8);
    expect(netWorkingHours('09:00', '17:45', 45)).toBe(8);
    expect(netWorkingHours('22:00', '06:00', 30)).toBe(7.5);
  });

  const ok = {
    startTime: '09:30',
    endTime: '18:30',
    breakMinutes: 60,
    minHoursForPresent: 8,
    minHoursForHalfDay: 4,
  };

  it('accepts a consistent configuration', () => {
    expect(shiftConsistencyError(ok)).toBeNull();
  });

  it('rejects a missing/negative break', () => {
    expect(shiftConsistencyError({ ...ok, breakMinutes: NaN })).toMatch(
      /required/,
    );
    expect(shiftConsistencyError({ ...ok, breakMinutes: -5 })).toMatch(
      /required/,
    );
  });

  it('accepts an explicit zero break', () => {
    expect(
      shiftConsistencyError({ ...ok, breakMinutes: 0, minHoursForPresent: 9 }),
    ).toBeNull();
  });

  it('rejects a break as long as the shift', () => {
    expect(shiftConsistencyError({ ...ok, breakMinutes: 540 })).toMatch(
      /shorter/,
    );
  });

  it('rejects Present hours above the net working hours', () => {
    expect(shiftConsistencyError({ ...ok, minHoursForPresent: 9 })).toMatch(
      /more than/,
    );
  });

  it('rejects Half Day hours not below Present', () => {
    expect(shiftConsistencyError({ ...ok, minHoursForHalfDay: 8 })).toMatch(
      /less than/,
    );
  });

  it('rejects end before start unless the shift crosses midnight', () => {
    const night = {
      ...ok,
      startTime: '22:00',
      endTime: '06:00',
      minHoursForPresent: 7,
    };
    expect(shiftConsistencyError({ ...night, crossesMidnight: false })).toMatch(
      /crosses midnight/,
    );
    expect(
      shiftConsistencyError({ ...night, crossesMidnight: true }),
    ).toBeNull();
  });
});

import { MAX_SHIFT_HOURS, shiftHours } from './work-schedules.service';

describe('shiftHours', () => {
  it('measures a normal day shift', () => {
    expect(shiftHours('09:30', '18:30')).toBe(9);
  });

  it('measures a shift that runs past midnight', () => {
    expect(shiftHours('22:00', '06:00')).toBe(8);
  });

  it('shows 03:30-19:30 is longer than the limit', () => {
    expect(shiftHours('03:30', '19:30')).toBe(16);
    expect(shiftHours('03:30', '19:30')).toBeGreaterThan(MAX_SHIFT_HOURS);
  });
});

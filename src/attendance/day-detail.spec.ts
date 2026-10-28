import { extraMinutesBeyondShift } from './day-detail';

describe('extraMinutesBeyondShift', () => {
  it('is the time worked past the shift length', () => {
    expect(extraMinutesBeyondShift(600, 480)).toBe(120);
  });
  it('is zero for a normal or short day', () => {
    expect(extraMinutesBeyondShift(480, 480)).toBe(0);
    expect(extraMinutesBeyondShift(300, 480)).toBe(0);
  });
  it('is zero with no punches or no shift length', () => {
    expect(extraMinutesBeyondShift(0, 480)).toBe(0);
    expect(extraMinutesBeyondShift(600, 0)).toBe(0);
  });
});

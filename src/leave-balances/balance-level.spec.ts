import { balanceLevel } from './balance-level';

describe('balanceLevel', () => {
  it('is NA when nothing was ever entitled', () => {
    expect(balanceLevel(0, 0)).toBe('NA');
  });
  it('is NONE at zero left', () => {
    expect(balanceLevel(0, 12)).toBe('NONE');
    expect(balanceLevel(0, 1)).toBe('NONE');
  });
  it('is LOW at 25% of the total or less, OK above it', () => {
    expect(balanceLevel(3, 12)).toBe('LOW'); // exactly 25%
    expect(balanceLevel(3.5, 12)).toBe('OK');
    expect(balanceLevel(22.5, 90)).toBe('LOW');
    expect(balanceLevel(23, 90)).toBe('OK');
  });
  it('uses 1 day as the low mark for a small total (4 days or fewer)', () => {
    expect(balanceLevel(1, 4)).toBe('LOW');
    expect(balanceLevel(1.5, 4)).toBe('OK');
    expect(balanceLevel(0.5, 2)).toBe('LOW');
    expect(balanceLevel(0.5, 1)).toBe('LOW');
  });
  it('never calls an untouched balance low, however small', () => {
    expect(balanceLevel(1, 1)).toBe('OK');
    expect(balanceLevel(2, 2)).toBe('OK');
    expect(balanceLevel(12, 12)).toBe('OK');
  });
  it('sets aside days that are waiting for approval', () => {
    expect(balanceLevel(2, 12, 2)).toBe('NONE');
    expect(balanceLevel(6, 12, 4)).toBe('LOW');
    expect(balanceLevel(6, 12, 0)).toBe('OK');
  });
});

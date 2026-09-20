import {
  daysBetween,
  noticeRecoveryAmount,
  noticeShortfallDays,
} from './notice-shortfall';

describe('notice shortfall maths', () => {
  it('counts calendar days between dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
  });

  it('is notice minus days served', () => {
    expect(noticeShortfallDays(60, '2026-01-01', '2026-01-31')).toBe(30);
  });

  it('is zero when notice was fully served or exceeded', () => {
    expect(noticeShortfallDays(30, '2026-01-01', '2026-01-31')).toBe(0);
    expect(noticeShortfallDays(30, '2026-01-01', '2026-03-01')).toBe(0);
  });

  it('is zero when notice period or submission date is unknown/invalid', () => {
    expect(noticeShortfallDays(null, '2026-01-01', '2026-01-31')).toBe(0);
    expect(noticeShortfallDays(0, '2026-01-01', '2026-01-31')).toBe(0);
    expect(noticeShortfallDays(30, null, '2026-01-31')).toBe(0);
    expect(noticeShortfallDays(30, 'bad', '2026-01-31')).toBe(0);
  });

  it('prices shortfall at the daily rate', () => {
    expect(noticeRecoveryAmount(10, 1000)).toBe(10000);
    expect(noticeRecoveryAmount(0, 1000)).toBe(0);
    expect(noticeRecoveryAmount(3, 333.33)).toBe(1000);
  });
});

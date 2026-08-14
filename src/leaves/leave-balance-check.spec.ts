import { checkAffordability } from './leave-balance-check';

const baseRow = {
  opening: 5,
  credited: 10,
  availed: 2,
  pending: 0,
  encashed: 0,
  adjusted: 0,
  carriedInExpiresOn: null,
};
const noNegative = { allowed: false, maxNegativeDays: 0 };

describe('checkAffordability', () => {
  it('allows a request within available balance', () => {
    const result = checkAffordability(baseRow, noNegative, 5, '2026-06-01');
    expect(result.ok).toBe(true);
    expect(result.available).toBe(13); // 5+10-2
    expect(result.shortfall).toBe(0);
  });

  it('subtracts pending from availability (unlike closing)', () => {
    const result = checkAffordability(
      { ...baseRow, pending: 8 },
      noNegative,
      6,
      '2026-06-01',
    );
    expect(result.available).toBe(5); // 13 - 8
    expect(result.ok).toBe(false);
    expect(result.shortfall).toBe(1);
  });

  it('rejects when insufficient and negative balance is not allowed', () => {
    const result = checkAffordability(baseRow, noNegative, 20, '2026-06-01');
    expect(result.ok).toBe(false);
    expect(result.shortfall).toBe(7);
  });

  it('allows an overdraft within maxNegativeDays', () => {
    const negative = { allowed: true, maxNegativeDays: 10 };
    const result = checkAffordability(baseRow, negative, 20, '2026-06-01');
    expect(result.ok).toBe(true);
    expect(result.shortfall).toBe(7);
  });

  it('rejects an overdraft beyond maxNegativeDays even when allowed', () => {
    const negative = { allowed: true, maxNegativeDays: 3 };
    const result = checkAffordability(baseRow, negative, 20, '2026-06-01');
    expect(result.ok).toBe(false);
  });

  it('forfeits the carried-in opening once its expiry has passed', () => {
    const row = { ...baseRow, carriedInExpiresOn: '2026-01-01' };
    const result = checkAffordability(row, noNegative, 5, '2026-06-01');
    expect(result.available).toBe(8); // opening (5) forfeited: 0+10-2
  });

  it('keeps the carried-in opening before its expiry', () => {
    const row = { ...baseRow, carriedInExpiresOn: '2026-12-31' };
    const result = checkAffordability(row, noNegative, 5, '2026-06-01');
    expect(result.available).toBe(13); // opening kept: 5+10-2
  });
});

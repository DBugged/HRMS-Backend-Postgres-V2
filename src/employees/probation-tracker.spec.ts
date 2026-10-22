import { compareProbation, probationBucket, probationDaysLeft } from './probation-tracker';

describe('probation tracker rules', () => {
  it('counts days to the end date, negative once it has passed', () => {
    expect(probationDaysLeft('2026-11-10', '2026-11-25')).toBe(15);
    expect(probationDaysLeft('2026-11-10', '2026-11-10')).toBe(0);
    expect(probationDaysLeft('2026-11-10', '2026-11-07')).toBe(-3);
    expect(probationDaysLeft('2026-11-10', null)).toBeNull();
  });

  it('groups by how urgent the decision is', () => {
    expect(probationBucket(-1)).toBe('OVERDUE');
    expect(probationBucket(0)).toBe('DUE_SOON');
    expect(probationBucket(30)).toBe('DUE_SOON');
    expect(probationBucket(31)).toBe('UPCOMING');
    expect(probationBucket(null)).toBe('NO_DATE');
  });

  it('lists the most overdue first, then the soonest, then people without a date', () => {
    const rows = [
      { name: 'D', daysLeft: null, bucket: probationBucket(null) },
      { name: 'C', daysLeft: 40, bucket: probationBucket(40) },
      { name: 'B', daysLeft: 5, bucket: probationBucket(5) },
      { name: 'A', daysLeft: -9, bucket: probationBucket(-9) },
      { name: 'A2', daysLeft: -2, bucket: probationBucket(-2) },
    ].sort(compareProbation);
    expect(rows.map((r) => r.name)).toEqual(['A', 'A2', 'B', 'C', 'D']);
  });
});

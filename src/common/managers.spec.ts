import {
  employedOnWhere,
  isEmployedOn,
  isManagerOf,
  managerIdsOf,
  reportsToWhere,
  splitManagerIds,
} from './managers';

describe('managers', () => {
  it('lists the primary first, then the extra managers, without duplicates or blanks', () => {
    expect(
      managerIdsOf({
        reportingManagerId: 'a',
        additionalReportingManagerIds: ['b', 'a', 'c'],
      }),
    ).toEqual(['a', 'b', 'c']);
    expect(
      managerIdsOf({
        reportingManagerId: null,
        additionalReportingManagerIds: ['b'],
      }),
    ).toEqual(['b']);
    expect(managerIdsOf({})).toEqual([]);
  });
  it('knows a manager as primary or additional', () => {
    const e = { reportingManagerId: 'a', additionalReportingManagerIds: ['b'] };
    expect(isManagerOf('a', e)).toBe(true);
    expect(isManagerOf('b', e)).toBe(true);
    expect(isManagerOf('z', e)).toBe(false);
  });
  it('builds a filter that matches both', () => {
    expect(reportsToWhere('m')).toEqual({
      OR: [
        { reportingManagerId: 'm' },
        { additionalReportingManagerIds: { has: 'm' } },
      ],
    });
  });
  it('splits a picked list into primary and additional, dropping the employee themself', () => {
    expect(splitManagerIds(['a', 'b', 'a', 'c'])).toEqual({
      reportingManagerId: 'a',
      additionalReportingManagerIds: ['b', 'c'],
    });
    expect(splitManagerIds(['me', 'b'], 'me')).toEqual({
      reportingManagerId: 'b',
      additionalReportingManagerIds: [],
    });
    expect(splitManagerIds([])).toEqual({
      reportingManagerId: null,
      additionalReportingManagerIds: [],
    });
  });
  it('stops counting a person after their last working day', () => {
    expect(isEmployedOn('2026-10-23', '2026-10-23')).toBe(true);
    expect(isEmployedOn('2026-10-23', '2026-10-24')).toBe(false);
    expect(isEmployedOn(null, '2030-01-01')).toBe(true);
  });

  it('counts someone who joined today at any time of day, but not tomorrow', () => {
    const lte = employedOnWhere('2026-10-29').joiningDate.lte.getTime();
    expect(new Date('2026-10-29T11:50:00.000Z').getTime()).toBeLessThanOrEqual(
      lte,
    );
    expect(new Date('2026-10-30T00:00:00.000Z').getTime()).toBeGreaterThan(lte);
  });
});

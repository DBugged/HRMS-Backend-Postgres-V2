import { effectiveWorkLocation } from './effective-work-location';

describe('effectiveWorkLocation', () => {
  const dept = { id: 'dept-loc', state: 'Karnataka' };
  const own = { id: 'own-loc', state: 'Maharashtra' };

  it('falls back to the department location when the employee has no override', () => {
    expect(
      effectiveWorkLocation({
        workLocation: null,
        department: { workLocation: dept },
      }),
    ).toBe(dept);
    expect(effectiveWorkLocation({ department: { workLocation: dept } })).toBe(
      dept,
    );
  });

  it('prefers the employee override over the department location', () => {
    expect(
      effectiveWorkLocation({
        workLocation: own,
        department: { workLocation: dept },
      }),
    ).toBe(own);
  });

  it('returns null when neither is set', () => {
    expect(effectiveWorkLocation({ department: null })).toBeNull();
    expect(effectiveWorkLocation({})).toBeNull();
  });
});

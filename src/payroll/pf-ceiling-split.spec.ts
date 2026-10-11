import {
  blendedPfCeiling,
  epsWagesForMonth,
  pfCeilingSegments,
} from './pf-ceiling-split';

const v = (
  from: string,
  to: string | null,
  ceiling: number,
  edli?: number,
) => ({
  effectiveFrom: from,
  effectiveTo: to,
  config: { wageCeiling: ceiling, edliMaxAmount: edli },
});
const history = [
  v('2020-01-01', '2026-09-16', 15000, 75),
  v('2026-09-17', null, 25000, 125),
];

describe('pfCeilingSegments', () => {
  it('splits September 2026 into 1-16 and 17-30', () => {
    expect(pfCeilingSegments(history, 9, 2026)).toEqual([
      { days: 16, wageCeiling: 15000, edliMax: 75 },
      { days: 14, wageCeiling: 25000, edliMax: 125 },
    ]);
  });
  it('is a single segment in months without a change', () => {
    expect(pfCeilingSegments(history, 8, 2026)).toHaveLength(1);
    expect(pfCeilingSegments(history, 10, 2026)).toHaveLength(1);
  });
  it('a change on the 1st of a month is not a split', () => {
    const h = [
      v('2020-01-01', '2026-09-30', 15000),
      v('2026-10-01', null, 25000),
    ];
    expect(pfCeilingSegments(h, 10, 2026)).toHaveLength(1);
  });
  it('merges adjacent versions with the same ceiling', () => {
    const h = [
      v('2020-01-01', '2026-09-10', 15000),
      v('2026-09-11', null, 15000),
    ];
    expect(pfCeilingSegments(h, 9, 2026)).toHaveLength(1);
  });
  it('returns nothing when no version covers the month', () => {
    expect(pfCeilingSegments([], 9, 2026)).toEqual([]);
  });
});

describe('blendedPfCeiling', () => {
  const seg = pfCeilingSegments(history, 9, 2026);
  it('has nothing to blend for one segment', () => {
    expect(
      blendedPfCeiling(30000, pfCeilingSegments(history, 8, 2026)),
    ).toBeNull();
  });
  it('wages above both ceilings: 16/30 of 15,000 + 14/30 of 25,000', () => {
    const b = blendedPfCeiling(30000, seg)!;
    expect(b.wageCeiling).toBeCloseTo(19666.67, 2);
    expect(Math.round(b.wageCeiling * 0.12)).toBe(2360);
    expect(b.edliMax).toBeCloseTo(75 * (16 / 30) + 125 * (14 / 30), 5);
  });
  it('wages between the ceilings', () => {
    const b = blendedPfCeiling(20000, seg)!;
    expect(b.wageCeiling).toBeCloseTo((16 * 15000 + 14 * 20000) / 30, 5);
  });
  it('wages below both ceilings are unchanged', () => {
    expect(blendedPfCeiling(10000, seg)!.wageCeiling).toBeCloseTo(10000, 8);
  });
});

describe('epsWagesForMonth (EPFO FAQ scenarios, September 2026)', () => {
  const seg = pfCeilingSegments(history, 9, 2026);

  it('an existing EPS member gets the full blended wages', () => {
    // EPFO FAQ: wages 20,000 -> 8,000 (16 days at 15,000) + 9,333 (14 days at 25,000).
    expect(epsWagesForMonth(20000, seg, 9, 2026, undefined, 25000)).toBe(17333);
  });

  it('a member enrolled from 17-Sep gets EPS wages for the last 14 days only', () => {
    expect(epsWagesForMonth(20000, seg, 9, 2026, '2026-09-16', 25000)).toBe(
      9333,
    );
  });

  it('a member who stays outside EPS gets none', () => {
    expect(epsWagesForMonth(20000, seg, 9, 2026, null, 25000)).toBe(0);
  });

  it('uses the fallback ceiling when the month has no segments', () => {
    expect(epsWagesForMonth(30000, [], 10, 2026, undefined, 25000)).toBe(25000);
  });

  it('is a full month once the exclusion has ended', () => {
    expect(epsWagesForMonth(20000, [], 10, 2026, '2026-09-16', 25000)).toBe(
      20000,
    );
  });
});

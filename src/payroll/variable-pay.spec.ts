import {
  cycleKeyOf,
  describeVariablePay,
  parseCycleKey,
  pendingHolds,
  pickCompanyPercent,
  releasedKeys,
} from './variable-pay';

describe('pickCompanyPercent', () => {
  const rows = [
    { departmentId: null, achievementPercent: 80 },
    { departmentId: 'eng', achievementPercent: 90 },
  ];
  it('department row wins over the company row', () => {
    expect(pickCompanyPercent(rows, 'eng')).toEqual({
      percent: 90,
      scope: 'DEPARTMENT',
    });
  });
  it('falls back to the company-wide row', () => {
    expect(pickCompanyPercent(rows, 'sales')).toEqual({
      percent: 80,
      scope: 'COMPANY',
    });
    expect(pickCompanyPercent(rows, null)).toEqual({
      percent: 80,
      scope: 'COMPANY',
    });
  });
  it('null (hold) when nothing is entered', () => {
    expect(pickCompanyPercent([], 'eng')).toBeNull();
    expect(
      pickCompanyPercent(
        [{ departmentId: 'ops', achievementPercent: 70 }],
        'eng',
      ),
    ).toBeNull();
  });
  it('allows 0% and values above 100%', () => {
    expect(
      pickCompanyPercent([{ departmentId: null, achievementPercent: 0 }], null)
        ?.percent,
    ).toBe(0);
    expect(
      pickCompanyPercent(
        [{ departmentId: null, achievementPercent: 350 }],
        null,
      )?.percent,
    ).toBe(350);
  });
});

describe('held payouts', () => {
  const held = {
    code: 'VARIABLE_PAY',
    name: 'Variable Pay',
    cycleKey: '2027-03',
    financialYear: '2026-27',
  };
  const march = { month: 3, year: 2027, earnings: [], heldVariablePay: [held] };

  it('a hold from an earlier run is pending', () => {
    expect(pendingHolds([march], 4, 2027, new Set())).toEqual([held]);
  });
  it('is not pending in the same month or earlier (that run pays it itself)', () => {
    expect(pendingHolds([march], 3, 2027, new Set())).toEqual([]);
    expect(pendingHolds([march], 2, 2027, new Set())).toEqual([]);
  });
  it('is settled once a run has paid a line stamped with its cycle', () => {
    const april = {
      month: 4,
      year: 2027,
      earnings: [{ code: 'VARIABLE_PAY', cycleKey: '2027-03' }],
      heldVariablePay: [],
    };
    const released = releasedKeys([march, april]);
    expect(released.has('VARIABLE_PAY|2027-03')).toBe(true);
    expect(pendingHolds([march, april], 5, 2027, released)).toEqual([]);
  });
  it('lists each hold once, oldest first', () => {
    const dec = { ...held, cycleKey: '2026-12' };
    const runs = [
      march,
      { month: 12, year: 2026, earnings: [], heldVariablePay: [dec, dec] },
    ];
    expect(
      pendingHolds(runs, 6, 2027, new Set()).map((h) => h.cycleKey),
    ).toEqual(['2026-12', '2027-03']);
  });
  it('ignores malformed data', () => {
    expect(
      pendingHolds(
        [{ month: 1, year: 2027, earnings: null, heldVariablePay: 'x' }],
        5,
        2027,
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe('helpers', () => {
  it('cycle keys round-trip', () => {
    expect(cycleKeyOf(3, 2027)).toBe('2027-03');
    expect(parseCycleKey('2027-03')).toEqual({ month: 3, year: 2027 });
    expect(parseCycleKey('bad')).toBeNull();
  });
  it('describes the working', () => {
    expect(describeVariablePay(12000, 80, 110)).toBe(
      '12000 × 80% company × 110% individual',
    );
    expect(describeVariablePay(12000, null, 100)).toBe(
      '12000 × 100% individual',
    );
    expect(describeVariablePay(12000, 150, 100, 'DEPARTMENT')).toBe(
      '12000 × 150% department × 100% individual',
    );
  });
});

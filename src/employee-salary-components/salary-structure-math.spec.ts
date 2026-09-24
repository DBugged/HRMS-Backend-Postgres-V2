import { CalcType } from '@prisma/client';
import {
  dayAfter,
  dayBefore,
  localDateStr,
  resolveCurrentRows,
  splitPeriodAtRevisions,
  synthesizeMissingRows,
  SynthesizableComponent,
} from './salary-structure-math';

describe('localDateStr', () => {
  it('formats a given instant as YYYY-MM-DD in the given org timezone', () => {
    const instant = new Date('2026-01-05T12:00:00.000Z');
    expect(localDateStr('UTC', instant)).toBe('2026-01-05');
  });

  it('pads single-digit months and days', () => {
    const instant = new Date('2026-09-03T12:00:00.000Z');
    expect(localDateStr('UTC', instant)).toBe('2026-09-03');
  });

  it('resolves against the org timezone, not the server-local clock — an', () => {
    // 2026-01-05T02:00:00Z is still 2026-01-04 in America/New_York (UTC-5
    // in Jan), the exact one-day skew this helper exists to avoid.
    const instant = new Date('2026-01-05T02:00:00.000Z');
    expect(localDateStr('UTC', instant)).toBe('2026-01-05');
    expect(localDateStr('America/New_York', instant)).toBe('2026-01-04');
  });
});

describe('dayBefore', () => {
  it('returns the previous calendar day', () => {
    expect(dayBefore('2026-06-15')).toBe('2026-06-14');
  });

  it('rolls back across a month boundary', () => {
    expect(dayBefore('2026-07-01')).toBe('2026-06-30');
  });

  it('rolls back across a year boundary', () => {
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
  });
});

describe('resolveCurrentRows', () => {
  it('picks the row whose range covers asOf', () => {
    const rows = [
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-05-31',
      },
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
      },
    ];
    const result = resolveCurrentRows(rows, '2026-07-01');
    expect(result).toHaveLength(1);
    expect(result[0].effectiveFrom).toBe('2026-06-01');
  });

  it('picks the historical row when asOf falls in its range', () => {
    const rows = [
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-05-31',
      },
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
      },
    ];
    const result = resolveCurrentRows(rows, '2026-03-15');
    expect(result[0].effectiveFrom).toBe('2026-01-01');
  });

  it('excludes rows outside the range entirely', () => {
    const rows = [
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
      },
    ];
    expect(resolveCurrentRows(rows, '2026-01-01')).toHaveLength(0);
  });

  it('dedupes to one row per componentCode across multiple components', () => {
    const rows = [
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
      { componentCode: 'HRA', effectiveFrom: '2026-01-01', effectiveTo: null },
    ];
    const result = resolveCurrentRows(rows, '2026-06-01');
    expect(result.map((r) => r.componentCode).sort()).toEqual(['BASIC', 'HRA']);
  });

  it('an open-ended row (effectiveTo null) covers any future asOf', () => {
    const rows = [
      {
        componentCode: 'BASIC',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    ];
    expect(resolveCurrentRows(rows, '2099-01-01')).toHaveLength(1);
  });
});

describe('synthesizeMissingRows', () => {
  function component(
    overrides: Partial<SynthesizableComponent>,
  ): SynthesizableComponent {
    return {
      id: 'comp-1',
      code: 'HRA',
      name: 'HRA',
      type: 'EARNING',
      calcType: CalcType.PERCENTAGE,
      isEmployerContribution: false,
      isActive: true,
      percentageOf: 'BASIC',
      percentageValue: 40,
      formula: null,
      displayOrder: 1,
      ...overrides,
    };
  }

  it('synthesizes a row for an active percentage earning with no override', () => {
    const result = synthesizeMissingRows([], [component({})], '2026-06-01');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      componentCode: 'HRA',
      valueType: CalcType.PERCENTAGE,
      synthesized: true,
      id: null,
    });
  });

  it('does not synthesize when an override row already covers the code', () => {
    const currentRows = [
      { componentCode: 'HRA', effectiveFrom: '2026-01-01', effectiveTo: null },
    ];
    expect(
      synthesizeMissingRows(currentRows, [component({})], '2026-06-01'),
    ).toHaveLength(0);
  });

  it('skips FIXED and MANUAL calcTypes', () => {
    expect(
      synthesizeMissingRows(
        [],
        [component({ calcType: CalcType.FIXED })],
        '2026-06-01',
      ),
    ).toHaveLength(0);
    expect(
      synthesizeMissingRows(
        [],
        [component({ calcType: CalcType.MANUAL })],
        '2026-06-01',
      ),
    ).toHaveLength(0);
  });

  it('skips DEDUCTION-type components', () => {
    expect(
      synthesizeMissingRows(
        [],
        [component({ type: 'DEDUCTION' })],
        '2026-06-01',
      ),
    ).toHaveLength(0);
  });

  it('skips employer-contribution components', () => {
    expect(
      synthesizeMissingRows(
        [],
        [component({ isEmployerContribution: true })],
        '2026-06-01',
      ),
    ).toHaveLength(0);
  });

  it('skips inactive components', () => {
    expect(
      synthesizeMissingRows([], [component({ isActive: false })], '2026-06-01'),
    ).toHaveLength(0);
  });

  it('includes a FORMULA-type component', () => {
    const result = synthesizeMissingRows(
      [],
      [
        component({
          calcType: CalcType.FORMULA,
          formula: 'BASIC * 0.1',
          percentageOf: null,
          percentageValue: null,
        }),
      ],
      '2026-06-01',
    );
    expect(result).toHaveLength(1);
    expect(result[0].formula).toBe('BASIC * 0.1');
  });
});

describe('dayAfter', () => {
  it('rolls over month and year ends', () => {
    expect(dayAfter('2026-06-30')).toBe('2026-07-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
  });
});

describe('splitPeriodAtRevisions', () => {
  const row = (effectiveFrom: string, effectiveTo: string | null) => ({
    componentCode: 'BASIC',
    effectiveFrom,
    effectiveTo,
  });

  it('is one segment when nothing changes inside the period', () => {
    expect(
      splitPeriodAtRevisions(
        [row('2026-01-01', null)],
        '2026-06-01',
        '2026-06-30',
      ),
    ).toEqual([{ start: '2026-06-01', end: '2026-06-30' }]);
  });

  it('a revision effective on the 1st does not split the month', () => {
    expect(
      splitPeriodAtRevisions(
        [row('2026-01-01', '2026-05-31'), row('2026-06-01', null)],
        '2026-06-01',
        '2026-06-30',
      ),
    ).toHaveLength(1);
  });

  it('splits at a mid-month revision', () => {
    expect(
      splitPeriodAtRevisions(
        [row('2026-01-01', '2026-06-15'), row('2026-06-16', null)],
        '2026-06-01',
        '2026-06-30',
      ),
    ).toEqual([
      { start: '2026-06-01', end: '2026-06-15' },
      { start: '2026-06-16', end: '2026-06-30' },
    ]);
  });

  it('splits at every boundary, including a row that simply ends mid-month', () => {
    expect(
      splitPeriodAtRevisions(
        [
          row('2026-01-01', '2026-06-09'),
          row('2026-06-10', '2026-06-19'),
          {
            componentCode: 'ALLOWANCE',
            effectiveFrom: '2026-01-01',
            effectiveTo: '2026-06-24',
          },
        ],
        '2026-06-01',
        '2026-06-30',
      ),
    ).toEqual([
      { start: '2026-06-01', end: '2026-06-09' },
      { start: '2026-06-10', end: '2026-06-19' },
      { start: '2026-06-20', end: '2026-06-24' },
      { start: '2026-06-25', end: '2026-06-30' },
    ]);
  });
});

import { CalcType } from '@prisma/client';
import {
  dayBefore,
  localDateStr,
  resolveCurrentRows,
  synthesizeMissingRows,
  SynthesizableComponent,
} from './salary-structure-math';

describe('localDateStr', () => {
  it('formats a given date as local YYYY-MM-DD', () => {
    const date = new Date(2026, 0, 5); // local Jan 5 2026 (month is 0-indexed)
    expect(localDateStr(date)).toBe('2026-01-05');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(2026, 8, 3); // local Sep 3 2026
    expect(localDateStr(date)).toBe('2026-09-03');
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

import { CalcType, PayFrequency } from '@prisma/client';
import {
  extractDependencies,
  resolveComponentValue,
  type ComponentLike,
  type ComponentOverrideLike,
} from './component-value-resolution';

function component(overrides: Partial<ComponentLike> = {}): ComponentLike {
  return {
    calcType: CalcType.FIXED,
    defaultValue: 0,
    percentageValue: null,
    percentageOf: null,
    formula: null,
    ...overrides,
  };
}

describe('resolveComponentValue', () => {
  it('FIXED: uses the override fixedAmount when present', () => {
    const c = component({ defaultValue: 10000 });
    const override: ComponentOverrideLike = {
      valueType: CalcType.FIXED,
      fixedAmount: 25000,
      percentageValue: null,
      percentageOf: null,
      formula: null,
      amountBasis: 'MONTHLY',
      isEnabled: true,
    };
    expect(resolveComponentValue(c, override, {})).toBe(25000);
  });

  it('FIXED: falls back to component.defaultValue with no override', () => {
    const c = component({ defaultValue: 10000 });
    expect(resolveComponentValue(c, null, {})).toBe(10000);
  });

  it('PERCENTAGE: resolves against the context', () => {
    const c = component({
      calcType: CalcType.PERCENTAGE,
      percentageValue: 40,
      percentageOf: 'BASIC',
    });
    expect(resolveComponentValue(c, null, { BASIC: 20000 })).toBe(8000);
  });

  it('PERCENTAGE: 0 when the dependency is missing from context', () => {
    const c = component({
      calcType: CalcType.PERCENTAGE,
      percentageValue: 40,
      percentageOf: 'BASIC',
    });
    expect(resolveComponentValue(c, null, {})).toBe(0);
  });

  it('FORMULA: evaluates via the formula engine', () => {
    const c = component({ calcType: CalcType.FORMULA, formula: 'BASIC * 0.1' });
    expect(resolveComponentValue(c, null, { BASIC: 20000 })).toBe(2000);
  });

  it('FORMULA: 0 when no formula string is present', () => {
    const c = component({ calcType: CalcType.FORMULA, formula: null });
    expect(resolveComponentValue(c, null, {})).toBe(0);
  });

  it('divides by 12 when amountBasis is ANNUAL', () => {
    const c = component({ defaultValue: 120000 });
    const override: ComponentOverrideLike = {
      valueType: CalcType.FIXED,
      fixedAmount: null,
      percentageValue: null,
      percentageOf: null,
      formula: null,
      amountBasis: 'ANNUAL',
      isEnabled: true,
    };
    expect(resolveComponentValue(c, override, {})).toBe(10000);
  });
});

describe('extractDependencies', () => {
  it('PERCENTAGE: returns the percentageOf code', () => {
    const c = component({
      calcType: CalcType.PERCENTAGE,
      percentageOf: 'BASIC',
    });
    expect(extractDependencies(c, null)).toEqual(['BASIC']);
  });

  it('FORMULA: returns the compiled referenced names', () => {
    const c = component({ calcType: CalcType.FORMULA, formula: 'BASIC + HRA' });
    expect(extractDependencies(c, null).sort()).toEqual(['BASIC', 'HRA']);
  });

  it('FIXED/MANUAL: no dependencies', () => {
    const c = component({ calcType: CalcType.FIXED });
    expect(extractDependencies(c, null)).toEqual([]);
  });

  it('an unparseable formula yields no dependencies rather than throwing', () => {
    const c = component({ calcType: CalcType.FORMULA, formula: 'BASIC +' });
    expect(extractDependencies(c, null)).toEqual([]);
  });
});

describe('resolveComponentValue: ANNUAL basis follows the pay frequency', () => {
  const annual = (amount: number): ComponentOverrideLike => ({
    valueType: CalcType.FIXED,
    fixedAmount: amount,
    percentageValue: null,
    percentageOf: null,
    formula: null,
    amountBasis: 'ANNUAL',
    isEnabled: true,
  });
  const withFreq = (payFrequency: PayFrequency) => ({
    calcType: CalcType.FIXED,
    defaultValue: 0,
    percentageValue: null,
    percentageOf: null,
    formula: null,
    payFrequency,
  });

  it('monthly component: a year total is paid 1/12 a month', () => {
    expect(
      resolveComponentValue(withFreq(PayFrequency.MONTHLY), annual(120000), {}),
    ).toBe(10000);
  });
  it('yearly component: the whole year total is paid in its one payout', () => {
    expect(
      resolveComponentValue(withFreq(PayFrequency.YEARLY), annual(50000), {}),
    ).toBe(50000);
  });
  it('half-yearly component: half the year total per payout', () => {
    expect(
      resolveComponentValue(
        withFreq(PayFrequency.HALF_YEARLY),
        annual(60000),
        {},
      ),
    ).toBe(30000);
  });
  it('quarterly component: a quarter of the year total per payout', () => {
    expect(
      resolveComponentValue(
        withFreq(PayFrequency.QUARTERLY),
        annual(60000),
        {},
      ),
    ).toBe(15000);
  });
  it('no frequency given keeps the old monthly behaviour', () => {
    expect(
      resolveComponentValue(
        {
          calcType: CalcType.FIXED,
          defaultValue: 0,
          percentageValue: null,
          percentageOf: null,
          formula: null,
        },
        annual(120000),
        {},
      ),
    ).toBe(10000);
  });
});

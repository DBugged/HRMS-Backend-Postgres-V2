import { CalcType } from '@prisma/client';
import {
  ComponentForCircularCheck,
  detectCircularReferences,
  isKnownFormulaReference,
  isValidPercentage,
  sampleEvaluationError,
} from './salary-component-validation';

function component(
  overrides: Partial<ComponentForCircularCheck>,
): ComponentForCircularCheck {
  return {
    code: 'X',
    name: 'X',
    calcType: CalcType.FIXED,
    percentageOf: null,
    formula: null,
    ...overrides,
  };
}

describe('detectCircularReferences', () => {
  it('does not throw for a valid acyclic set', () => {
    const components = [
      component({ code: 'BASIC', name: 'Basic' }),
      component({
        code: 'HRA',
        name: 'HRA',
        calcType: CalcType.PERCENTAGE,
        percentageOf: 'BASIC',
      }),
      component({
        code: 'GROSS',
        name: 'Gross',
        calcType: CalcType.FORMULA,
        formula: 'BASIC + HRA',
      }),
    ];
    expect(() => detectCircularReferences(components)).not.toThrow();
  });

  it('detects a percentage-based cycle', () => {
    const components = [
      component({
        code: 'A',
        name: 'A',
        calcType: CalcType.PERCENTAGE,
        percentageOf: 'B',
      }),
      component({
        code: 'B',
        name: 'B',
        calcType: CalcType.PERCENTAGE,
        percentageOf: 'A',
      }),
    ];
    expect(() => detectCircularReferences(components)).toThrow(
      /Circular reference detected in salary formulas/,
    );
  });

  it('detects a formula-based cycle', () => {
    const components = [
      component({
        code: 'A',
        name: 'A',
        calcType: CalcType.FORMULA,
        formula: 'B + 1',
      }),
      component({
        code: 'B',
        name: 'B',
        calcType: CalcType.FORMULA,
        formula: 'A + 1',
      }),
    ];
    expect(() => detectCircularReferences(components)).toThrow(
      /Circular reference detected in salary formulas/,
    );
  });

  it('a formula referencing only system vars (unknown codes) is not a cycle', () => {
    const components = [
      component({
        code: 'PT',
        name: 'PT',
        calcType: CalcType.FORMULA,
        formula: 'GROSS_EARNINGS * PF_EMPLOYEE_RATE',
      }),
    ];
    expect(() => detectCircularReferences(components)).not.toThrow();
  });

  it('rejects an invalid formula with a component-name-attributed error', () => {
    const components = [
      component({
        code: 'BAD',
        name: 'Broken Component',
        calcType: CalcType.FORMULA,
        formula: 'BASIC +',
      }),
    ];
    expect(() => detectCircularReferences(components)).toThrow(
      'Invalid formula for "Broken Component":',
    );
  });

  it('a disabled (excluded) component removes its edges from the graph', () => {
    // Only the active subset is passed in — mirrors the service filtering
    // to isActive:true before calling this function.
    const components = [
      component({
        code: 'GROSS',
        name: 'Gross',
        calcType: CalcType.FORMULA,
        formula: 'RETIRED_COMPONENT + 1',
      }),
    ];
    expect(() => detectCircularReferences(components)).not.toThrow();
  });
});

describe('isValidPercentage', () => {
  it.each([0, 50, 100])('accepts %s', (v) => {
    expect(isValidPercentage(v)).toBe(true);
  });

  it.each([-1, 101, NaN, Infinity, '50', null, undefined])(
    'rejects %s',
    (v) => {
      expect(isValidPercentage(v)).toBe(false);
    },
  );
});

describe('isKnownFormulaReference', () => {
  const codes = new Set(['BASIC', 'HRA']);

  it('accepts active component codes, system variables and PT slab variables', () => {
    expect(isKnownFormulaReference('BASIC', codes)).toBe(true);
    expect(isKnownFormulaReference('GROSS_EARNINGS', codes)).toBe(true);
    expect(isKnownFormulaReference('OT_WEIGHTED_HOURS', codes)).toBe(true);
    expect(isKnownFormulaReference('PT_SLAB3_AMOUNT', codes)).toBe(true);
    expect(isKnownFormulaReference('PT_SLAB12_UPTO', codes)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isKnownFormulaReference('NONEXISTENT', codes)).toBe(false);
    expect(isKnownFormulaReference('PT_SLAB_X_AMOUNT', codes)).toBe(false);
  });
});

// Save/validate-time smoke test: a formula that can only ever produce
// NaN/Infinity (or can't be evaluated at all) is reported, instead of being
// accepted and paid out later.
describe('sampleEvaluationError', () => {
  it('is null for the seeded statutory formulas and ordinary expressions', () => {
    for (const formula of [
      'ROUND(MIN(PF_WAGES, PF_WAGE_CEILING) * PF_EMPLOYEE_RATE / 100, 0)',
      'IF(ESI_APPLICABLE == 1, ROUND(GROSS_EARNINGS * ESI_EMPLOYEE_RATE / 100, 0), 0)',
      'PT_SLAB_AMOUNT(GROSS_EARNINGS)',
      'IF(GROSS_EARNINGS <= PT_SLAB1_UPTO, PT_SLAB1_AMOUNT, IF(GROSS_EARNINGS <= PT_SLAB2_UPTO, PT_SLAB2_AMOUNT, PT_SLAB3_AMOUNT))',
      'ROUND(OT_WEIGHTED_HOURS * (BASIC / 200), 0)',
      'BASIC * 0.4',
      // Component codes that don't exist get a sample value too — unknown
      // references are a separate check.
      'SOME_CUSTOM_CODE + 1',
    ]) {
      expect(sampleEvaluationError(formula)).toBeNull();
    }
  });

  it('reports formulas that parse but cannot produce a finite amount', () => {
    expect(sampleEvaluationError('MIN()')).toMatch(/MIN\(\) expects/);
    expect(sampleEvaluationError('IF(1 > 2, 5)')).toMatch(/IF\(\) expects/);
    expect(sampleEvaluationError('.')).toMatch(/Invalid number/);
    expect(sampleEvaluationError('ROUND(BASIC, 400)')).toMatch(/ROUND\(\)/);
    expect(sampleEvaluationError(Array(100).fill('BASIC').join(' * '))).toMatch(
      /non-finite/,
    );
  });

  it('reports a parse error', () => {
    expect(sampleEvaluationError('BASIC +')).not.toBeNull();
  });
});

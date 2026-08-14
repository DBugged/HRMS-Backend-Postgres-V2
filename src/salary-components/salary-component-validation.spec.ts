import { CalcType } from '@prisma/client';
import {
  ComponentForCircularCheck,
  detectCircularReferences,
  isValidPercentage,
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

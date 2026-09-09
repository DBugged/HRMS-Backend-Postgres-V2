import {
  compileFormula,
  evaluateFormula,
  topoSortComponents,
} from './formula-engine';

describe('evaluateFormula — arithmetic and precedence', () => {
  it('evaluates basic arithmetic with correct precedence', () => {
    expect(evaluateFormula('2 + 3 * 4', {})).toBe(14);
  });

  it('respects parentheses', () => {
    expect(evaluateFormula('(2 + 3) * 4', {})).toBe(20);
  });

  it('supports unary minus', () => {
    expect(evaluateFormula('-5 + 10', {})).toBe(5);
  });

  it('modulo is a binary operator, not a percent suffix', () => {
    expect(evaluateFormula('10 % 3', {})).toBe(1);
  });

  it('division by zero returns 0, not Infinity/NaN', () => {
    expect(evaluateFormula('10 / 0', {})).toBe(0);
  });

  it('modulo by zero returns 0', () => {
    expect(evaluateFormula('10 % 0', {})).toBe(0);
  });

  it('resolves identifiers from context, case-insensitively', () => {
    expect(evaluateFormula('basic + hra', { BASIC: 100, HRA: 50 })).toBe(150);
  });

  it('throws on an unknown identifier', () => {
    expect(() => evaluateFormula('UNKNOWN_VAR', {})).toThrow(
      'Unknown reference "UNKNOWN_VAR" in formula',
    );
  });
});

describe('evaluateFormula — comparisons', () => {
  it('comparisons evaluate to 1/0, not booleans', () => {
    expect(evaluateFormula('5 > 3', {})).toBe(1);
    expect(evaluateFormula('5 < 3', {})).toBe(0);
    expect(evaluateFormula('5 >= 5', {})).toBe(1);
    expect(evaluateFormula('5 <= 4', {})).toBe(0);
    expect(evaluateFormula('5 == 5', {})).toBe(1);
    expect(evaluateFormula('5 != 5', {})).toBe(0);
  });
});

describe('evaluateFormula — functions', () => {
  it('IF branches on truthy/falsy', () => {
    expect(evaluateFormula('IF(1, 10, 20)', {})).toBe(10);
    expect(evaluateFormula('IF(0, 10, 20)', {})).toBe(20);
  });

  it('AND is 1 only when every arg is truthy', () => {
    expect(evaluateFormula('AND(1, 1, 1)', {})).toBe(1);
    expect(evaluateFormula('AND(1, 0, 1)', {})).toBe(0);
  });

  it('OR is 1 when any arg is truthy', () => {
    expect(evaluateFormula('OR(0, 0, 1)', {})).toBe(1);
    expect(evaluateFormula('OR(0, 0, 0)', {})).toBe(0);
  });

  it('NOT inverts', () => {
    expect(evaluateFormula('NOT(1)', {})).toBe(0);
    expect(evaluateFormula('NOT(0)', {})).toBe(1);
  });

  it('ROUND defaults to 0 decimals', () => {
    expect(evaluateFormula('ROUND(2.6)', {})).toBe(3);
  });

  it('ROUND respects an explicit decimals arg', () => {
    expect(evaluateFormula('ROUND(2.567, 2)', {})).toBe(2.57);
  });

  it('MIN/MAX/ABS', () => {
    expect(evaluateFormula('MIN(3, 1, 2)', {})).toBe(1);
    expect(evaluateFormula('MAX(3, 1, 2)', {})).toBe(3);
    expect(evaluateFormula('ABS(-5)', {})).toBe(5);
  });

  it('PERCENT computes base*pct/100', () => {
    expect(evaluateFormula('PERCENT(200, 50)', {})).toBe(100);
  });

  it('functions compose with arithmetic and nesting', () => {
    expect(
      evaluateFormula('IF(BASIC > 10000, PERCENT(BASIC, 40), 0)', {
        BASIC: 20000,
      }),
    ).toBe(8000);
  });

  it('throws on an unknown function name', () => {
    expect(() => evaluateFormula('NOPE(1)', {})).toThrow(
      'Unknown function "NOPE" in formula',
    );
  });
});

describe('compileFormula', () => {
  it('collects every referenced identifier, including inside call args', () => {
    const { referencedNames } = compileFormula('IF(BASIC > HRA, DA, 0)');
    expect(referencedNames.sort()).toEqual(['BASIC', 'DA', 'HRA']);
  });

  it('does not include function names as referenced identifiers', () => {
    const { referencedNames } = compileFormula('ROUND(BASIC, 2)');
    expect(referencedNames).not.toContain('ROUND');
    expect(referencedNames).toEqual(['BASIC']);
  });

  it('throws a parse error on malformed input', () => {
    expect(() => compileFormula('BASIC +')).toThrow();
    expect(() => compileFormula('(BASIC + HRA')).toThrow(
      'Expected ")" in formula',
    );
  });
});

describe('topoSortComponents', () => {
  it('returns a valid dependency order for an acyclic graph', () => {
    const order = topoSortComponents({ A: ['B'], B: ['C'], C: [] });
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('A'));
  });

  it('ignores edges pointing at unknown keys (system vars)', () => {
    expect(() => topoSortComponents({ A: ['SYSTEM_VAR'] })).not.toThrow();
  });

  it('throws with the exact cycle path on a direct cycle', () => {
    expect(() => topoSortComponents({ A: ['B'], B: ['A'] })).toThrow(
      'Circular reference detected in salary formulas: A -> B -> A',
    );
  });

  it('throws on a longer cycle', () => {
    expect(() => topoSortComponents({ A: ['B'], B: ['C'], C: ['A'] })).toThrow(
      /Circular reference detected in salary formulas: A -> B -> C -> A/,
    );
  });

  it('a self-referencing component is a cycle of length 1', () => {
    expect(() => topoSortComponents({ A: ['A'] })).toThrow(
      'Circular reference detected in salary formulas: A -> A',
    );
  });
});

// The seeded PT formula used to enumerate exactly three slabs, so it threw
// for an org with two and silently capped an org with four. PT_SLAB_AMOUNT
// walks whatever the org actually configured.
describe('PT_SLAB_AMOUNT', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const twoSlabs = {
    PT_SLAB1_UPTO: 15000,
    PT_SLAB1_AMOUNT: 0,
    PT_SLAB2_UPTO: MAX,
    PT_SLAB2_AMOUNT: 200,
  };
  const threeSlabs = {
    PT_SLAB1_UPTO: 7500,
    PT_SLAB1_AMOUNT: 0,
    PT_SLAB2_UPTO: 10000,
    PT_SLAB2_AMOUNT: 175,
    PT_SLAB3_UPTO: MAX,
    PT_SLAB3_AMOUNT: 200,
  };
  const fourSlabs = {
    ...threeSlabs,
    PT_SLAB3_UPTO: 20000,
    PT_SLAB4_UPTO: MAX,
    PT_SLAB4_AMOUNT: 300,
  };

  it('picks the right slab in a three-slab config', () => {
    const f = 'PT_SLAB_AMOUNT(GROSS_EARNINGS)';
    expect(evaluateFormula(f, { ...threeSlabs, GROSS_EARNINGS: 7000 })).toBe(0);
    expect(evaluateFormula(f, { ...threeSlabs, GROSS_EARNINGS: 9000 })).toBe(
      175,
    );
    expect(evaluateFormula(f, { ...threeSlabs, GROSS_EARNINGS: 90000 })).toBe(
      200,
    );
  });

  it('works for a two-slab org instead of throwing on a missing slab 3', () => {
    const f = 'PT_SLAB_AMOUNT(GROSS_EARNINGS)';
    expect(evaluateFormula(f, { ...twoSlabs, GROSS_EARNINGS: 12000 })).toBe(0);
    expect(evaluateFormula(f, { ...twoSlabs, GROSS_EARNINGS: 50000 })).toBe(
      200,
    );
  });

  it('reaches the fourth slab instead of capping at the third', () => {
    const f = 'PT_SLAB_AMOUNT(GROSS_EARNINGS)';
    expect(evaluateFormula(f, { ...fourSlabs, GROSS_EARNINGS: 15000 })).toBe(
      200,
    );
    expect(evaluateFormula(f, { ...fourSlabs, GROSS_EARNINGS: 50000 })).toBe(
      300,
    );
  });

  it('returns the top slab when every ceiling is exceeded', () => {
    // No open-ended slab configured at all — still resolves rather than
    // running off the end.
    expect(
      evaluateFormula('PT_SLAB_AMOUNT(GROSS_EARNINGS)', {
        PT_SLAB1_UPTO: 5000,
        PT_SLAB1_AMOUNT: 0,
        PT_SLAB2_UPTO: 10000,
        PT_SLAB2_AMOUNT: 150,
        GROSS_EARNINGS: 99999,
      }),
    ).toBe(150);
  });

  it('is 0 when no slabs are configured', () => {
    expect(evaluateFormula('PT_SLAB_AMOUNT(10000)', {})).toBe(0);
  });
});

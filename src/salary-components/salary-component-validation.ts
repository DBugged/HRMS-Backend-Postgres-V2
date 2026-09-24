import { CalcType } from '@prisma/client';
import {
  compileFormula,
  evaluateFormula,
  SYSTEM_VARS,
  topoSortComponents,
} from './formula-engine';

export interface ComponentForCircularCheck {
  code: string;
  name: string;
  calcType: CalcType;
  percentageOf: string | null;
  formula: string | null;
}

/**
 * Pure port of the old salaryComponentController.js's
 * `assertNoCircularReferences`. Builds the org's full dependency graph
 * (PERCENTAGE -> percentageOf, FORMULA -> compiled referencedNames
 * filtered to known component codes) and runs it through
 * `topoSortComponents`, which throws on a cycle. Callers pass the
 * candidate (new-or-edited) row already overlaid into `components`, and
 * only `isActive` components — matching the old system's "an edit that
 * disables a component removes it from the graph" behavior.
 */
export function detectCircularReferences(
  components: ComponentForCircularCheck[],
): void {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const edges: Record<string, string[]> = {};

  for (const component of components) {
    if (component.calcType === CalcType.PERCENTAGE) {
      edges[component.code] = component.percentageOf
        ? [component.percentageOf]
        : [];
    } else if (component.calcType === CalcType.FORMULA) {
      if (!component.formula) {
        edges[component.code] = [];
        continue;
      }
      let referencedNames: string[];
      try {
        referencedNames = compileFormula(component.formula).referencedNames;
      } catch (err) {
        throw new Error(
          `Invalid formula for "${component.name}": ${(err as Error).message}`,
        );
      }
      edges[component.code] = referencedNames.filter((name) =>
        byCode.has(name),
      );
    } else {
      edges[component.code] = [];
    }
  }

  topoSortComponents(edges);
}

// PT_SLAB<n>_UPTO / PT_SLAB<n>_AMOUNT are flattened into the run-time context
// for however many PT slabs the org has (see buildPtSlabContext in
// payroll/formula-context.ts) — orgs seeded before PT_SLAB_AMOUNT() existed
// still reference them by name, so they are valid references even though
// they can't be listed statically in SYSTEM_VARS.
const PT_SLAB_VAR = /^PT_SLAB\d+_(UPTO|AMOUNT)$/;

export function isKnownFormulaReference(
  name: string,
  componentCodes: ReadonlySet<string>,
): boolean {
  return (
    componentCodes.has(name) ||
    (SYSTEM_VARS as readonly string[]).includes(name) ||
    PT_SLAB_VAR.test(name)
  );
}

// Plausible values for every system variable — only used to smoke-test a
// formula before it is saved, never for payroll itself.
const SAMPLE_SYSTEM_VALUES: Record<(typeof SYSTEM_VARS)[number], number> = {
  WORKING_DAYS: 26,
  TOTAL_DAYS_IN_MONTH: 30,
  PRESENT_DAYS: 24,
  PAID_LEAVE_DAYS: 1,
  UNPAID_LEAVE_DAYS: 1,
  HALF_DAYS: 1,
  OT_HOURS: 10,
  OT_WEIGHTED_HOURS: 15,
  LATE_MARKS: 2,
  HOLIDAY_WORK_DAYS: 1,
  WEEKEND_WORK_DAYS: 1,
  LOP_DAYS: 1,
  PAYABLE_DAYS: 29,
  HOLIDAYS: 1,
  WEEKLY_OFFS: 4,
  GROSS_EARNINGS: 50000,
  TOTAL_DEDUCTIONS: 5000,
  PF_EMPLOYEE_RATE: 12,
  PF_EMPLOYER_RATE: 12,
  PF_WAGE_CEILING: 15000,
  ESI_EMPLOYEE_RATE: 0.75,
  ESI_EMPLOYER_RATE: 3.25,
  ESI_WAGE_CEILING: 21000,
  LWF_EMPLOYEE_AMOUNT: 25,
  LWF_EMPLOYER_AMOUNT: 75,
  NPS_EMPLOYER_RATE: 10,
  GRATUITY_RATE: 4.81,
  BASIC_DA: 20000,
  PF_WAGES: 20000,
  GRATUITY_WAGES: 20000,
  NPS_WAGES: 20000,
  ESI_APPLICABLE: 1,
  PF_EDLI_RATE: 0.5,
  PF_ADMIN_RATE: 0.5,
  PF_EDLI_MAX: 75,
  BONUS_RATE: 8.33,
  BONUS_ELIGIBILITY_CEILING: 21000,
  BONUS_CALC_CEILING: 7000,
};

const SAMPLE_COMPONENT_VALUE = 10000;

/**
 * A representative formula context: every system variable, a PT ladder, and
 * a sample amount for each given component code / extra name. Used to
 * evaluate a formula once at save/validate time so one that can only ever
 * produce NaN/Infinity (or throws for any input) is rejected before it
 * reaches a payroll run.
 */
export function buildSampleFormulaContext(
  names: Iterable<string>,
): Record<string, number> {
  const context: Record<string, number> = {
    ...SAMPLE_SYSTEM_VALUES,
    PT_SLAB1_UPTO: 7500,
    PT_SLAB1_AMOUNT: 0,
    PT_SLAB2_UPTO: 10000,
    PT_SLAB2_AMOUNT: 175,
    PT_SLAB3_UPTO: Number.MAX_SAFE_INTEGER,
    PT_SLAB3_AMOUNT: 200,
  };
  for (const name of names) {
    if (!(name in context)) context[name] = SAMPLE_COMPONENT_VALUE;
  }
  return context;
}

/**
 * Compiles and evaluates `formula` against the sample context. Returns the
 * error message when the formula fails to parse, throws, or produces a
 * non-finite value; null when it is usable. Every name the formula
 * references gets a sample value, so an unknown reference is NOT reported
 * here — callers check references separately (isKnownFormulaReference).
 */
export function sampleEvaluationError(formula: string): string | null {
  try {
    const { referencedNames } = compileFormula(formula);
    const value = evaluateFormula(
      formula,
      buildSampleFormulaContext(referencedNames),
    );
    if (!Number.isFinite(value)) {
      return `Formula produced a non-finite value (${value})`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function isValidPercentage(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

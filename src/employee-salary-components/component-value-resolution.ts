import { CalcType } from '@prisma/client';
import {
  compileFormula,
  evaluateFormula,
} from '../salary-components/formula-engine';

/**
 * Ported verbatim from the old backend's payrollEngine.js
 * resolveComponentValue/extractDependencies — resolves one component's
 * current monthly value outside a full payroll run (used by Leave
 * Encashment's "current BASIC" rate, and will be reused by Payroll core).
 * Pure functions: no DB access, the caller resolves the SalaryComponent
 * row + any EmployeeSalaryComponent override and passes plain data in.
 *
 * Old system's own doc-comment, carried forward: "only resolves
 * fixed/percentage-of-another-fixed-component correctly (sufficient for
 * BASIC, which never depends on a formula in practice); formula-type
 * components resolve against an empty/partial context and may return 0 if
 * they reference attendance/other variables." Not silently fixed here —
 * ported with the same limitation.
 */

export interface ComponentLike {
  calcType: CalcType;
  defaultValue: number | null;
  percentageValue: number | null;
  percentageOf: string | null;
  formula: string | null;
}

export interface ComponentOverrideLike {
  valueType: CalcType;
  fixedAmount: number | null;
  percentageValue: number | null;
  percentageOf: string | null;
  formula: string | null;
  amountBasis: 'MONTHLY' | 'ANNUAL';
  isEnabled: boolean;
}

export function resolveComponentValue(
  component: ComponentLike,
  override: ComponentOverrideLike | null | undefined,
  context: Record<string, number>,
): number {
  const valueType = override?.valueType ?? component.calcType;
  let raw = 0;

  if (valueType === CalcType.FIXED || valueType === CalcType.MANUAL) {
    raw = override?.fixedAmount ?? component.defaultValue ?? 0;
  } else if (valueType === CalcType.PERCENTAGE) {
    const pct = override?.percentageValue ?? component.percentageValue ?? 0;
    const ofCode = override?.percentageOf || component.percentageOf;
    const base = ofCode ? (context[ofCode] ?? 0) : 0;
    raw = (base * pct) / 100;
  } else if (valueType === CalcType.FORMULA) {
    const formula = override?.formula || component.formula;
    raw = formula ? evaluateFormula(formula, context) : 0;
  }

  const basis = override?.amountBasis ?? 'MONTHLY';
  return basis === 'ANNUAL' ? raw / 12 : raw;
}

export function extractDependencies(
  component: ComponentLike,
  override: ComponentOverrideLike | null | undefined,
): string[] {
  const valueType = override?.valueType ?? component.calcType;

  if (valueType === CalcType.PERCENTAGE) {
    const ofCode = override?.percentageOf || component.percentageOf;
    return ofCode ? [ofCode] : [];
  }
  if (valueType === CalcType.FORMULA) {
    const formula = override?.formula || component.formula;
    if (!formula) return [];
    try {
      return compileFormula(formula).referencedNames;
    } catch {
      return [];
    }
  }
  return [];
}

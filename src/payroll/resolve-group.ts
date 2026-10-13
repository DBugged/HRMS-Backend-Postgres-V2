// Purpose: Resolve a group of salary components (earnings, deductions or employer contributions) to amounts, in
//   dependency order, against a formula context.
// Responsibilities: orders the components by what they reference, evaluates each with its per-employee override, applies
//   attendance proration to FIXED values and keeps a running context so later components see earlier ones.
// Important: pure - no database. Shared by PayrollService.calculatePayroll and the salary-structure preview, so a
//   previewed breakup is computed by exactly the code that pays it.
import {
  CalcType,
  SalaryComponentType,
  StatutoryKey,
  type EmployeeSalaryComponent,
  type SalaryComponent,
} from '@prisma/client';
import { isComponentPayableThisMonth } from './payroll-date-math';
import type { OverlaidSettings } from './statutory-overlay';
import {
  extractDependencies,
  resolveComponentValue,
} from '../employee-salary-components/component-value-resolution';
import { topoSortComponents } from '../salary-components/formula-engine';

export interface ResolvedLine {
  code: string;
  name: string;
  amount: number;
  taxable?: boolean;
  component?: SalaryComponent;
  // Rows this line was built from (encashment ids on LEAVE_ENCASHMENT, the
  // loan id on LOAN_EMI). Persisted with the line so afterLock() settles
  // exactly what the locked payslip actually contains — see afterLock().
  sourceIds?: string[];
  // Variable pay scaled by company performance: how the amount was worked
  // out ("12000 × 80% company × 110% individual"), and — on a payout released
  // after being held — the original payout month ("2027-03") it settles.
  note?: string;
  cycleKey?: string;
}

export function resolveGroup(
  components: SalaryComponent[],
  overridesByCode: Map<string, EmployeeSalaryComponent>,
  context: Record<string, number>,
  prorationFactor: number,
  roundAmount: (n: number) => number,
): { results: ResolvedLine[]; context: Record<string, number> } {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const edges: Record<string, string[]> = {};
  for (const c of components) {
    const override = overridesByCode.get(c.code) ?? null;
    // BASIC_RATE is Basic before attendance proration, so a formula using it has to wait for BASIC.
    edges[c.code] = extractDependencies(c, override)
      .map((name) => (name === 'BASIC_RATE' ? 'BASIC' : name))
      .filter((code) => byCode.has(code));
  }
  const order = topoSortComponents(edges);

  const results: ResolvedLine[] = [];
  const localContext = { ...context };
  localContext.BASIC_RATE ??= 0;

  for (const code of order) {
    const component = byCode.get(code);
    if (!component) continue;
    const override = overridesByCode.get(code) ?? null;
    const valueType = override?.valueType ?? component.calcType;
    let value: number;
    try {
      value = resolveComponentValue(component, override, localContext);
    } catch (err) {
      throw new Error(
        `Salary component "${component.name}" (${code}): ${(err as Error).message}`,
      );
    }

    // The month's full Basic rate, before the attendance proration below. Overtime pays at this rate: a part
    // month (joiner, leave, LOP) must not lower the hourly rate of the overtime actually worked.
    if (code === 'BASIC') {
      localContext.BASIC_RATE = roundAmount(Math.max(0, value));
    }
    if (valueType === CalcType.FIXED) {
      value = value * prorationFactor;
    }
    // Math.max(0, NaN) is NaN — this used to carry a NaN straight onto the
    // payslip.
    if (!Number.isFinite(value)) {
      throw new Error(
        `Salary component "${component.name}" (${code}) produced a non-numeric amount (${value}) — check its formula/value.`,
      );
    }
    // MANUAL lines (arrears, one-off corrections) are exempt from the
    // floor: a negative MANUAL amount is a deliberate clawback/recovery
    // entered by HR, not a formula error, and clamping it to 0 silently
    // discards the recovery with no trace on the payslip or in failures[].
    if (valueType !== CalcType.MANUAL) {
      value = Math.max(0, value);
    }
    localContext[code] = roundAmount(value);
    results.push({
      code,
      name: component.name,
      amount: value,
      taxable: component.isTaxable,
      component,
    });
  }
  return { results, context: localContext };
}

export type StatutoryEnabledKey =
  | 'pfEnabled'
  | 'esiEnabled'
  | 'ptEnabled'
  | 'lwfEnabled'
  | 'npsEnabled'
  | 'gratuityEnabled'
  | 'bonusEnabled'
  | 'incomeTaxEnabled';

export const STATUTORY_ENABLED_KEY: Partial<
  Record<StatutoryKey, StatutoryEnabledKey>
> = {
  [StatutoryKey.PF]: 'pfEnabled',
  [StatutoryKey.ESI]: 'esiEnabled',
  [StatutoryKey.PT]: 'ptEnabled',
  [StatutoryKey.LWF]: 'lwfEnabled',
  [StatutoryKey.NPS]: 'npsEnabled',
  [StatutoryKey.GRATUITY]: 'gratuityEnabled',
  [StatutoryKey.BONUS]: 'bonusEnabled',
  [StatutoryKey.INCOME_TAX]: 'incomeTaxEnabled',
  // EMPLOYER_INSURANCE removed (never seeded/used) — Statutory Key stays
  // selectable in schema.prisma/SalaryComponents.tsx dropdowns for now (see
  // that screen for the removal from the picker), but no longer maps to an
  // org-level enable flag; re-add here (plus the org toggle in
  // update-payroll-settings.dto.ts/PayrollSettingsPage.tsx/
  // statutory-overlay.ts) if this is ever requested again.
};

export function isComponentApplicable(
  component: SalaryComponent,
  override: EmployeeSalaryComponent | null,
  month: number,
  settings: OverlaidSettings,
): boolean {
  if (
    !isComponentPayableThisMonth(
      component.payFrequency,
      month,
      settings.financialYearStartMonth,
    )
  ) {
    return false;
  }

  // A manually assigned payout (Bonus, ...) is HR's explicit instruction for this employee. The statutory
  // switch controls the statutory *accrual/contribution* components; applying it here silently paid a
  // manually entered Bonus as zero whenever the Bonus module was off.
  const isManualPayout =
    component.type === SalaryComponentType.EARNING &&
    !component.isEmployerContribution &&
    (override?.valueType ?? component.calcType) === CalcType.MANUAL;
  if (component.isStatutory && !isManualPayout) {
    const key = component.statutoryKey
      ? STATUTORY_ENABLED_KEY[component.statutoryKey]
      : undefined;
    if (key && !settings[key]) return false;
    if (override && override.isEnabled === false) return false;
    return true;
  }

  if (
    component.calcType === CalcType.PERCENTAGE ||
    component.calcType === CalcType.FORMULA
  ) {
    return !override || override.isEnabled !== false;
  }

  return !!override && override.isEnabled !== false;
}

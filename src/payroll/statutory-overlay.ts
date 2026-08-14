import { PayrollSettings, StatutoryModule } from '@prisma/client';

/**
 * Overlays the Statutory Compliance Center's effective-for-this-period
 * versions onto the flat PayrollSettings row, module by module — ported
 * verbatim from payrollEngine.js's applyStatutoryOverrides. A module with
 * no version yet keeps its existing PayrollSettings value untouched, so
 * rollout is behaviorally invisible until someone actually adds a version.
 */

export interface PtSlab {
  upTo: number | null;
  amount: number;
}

export interface EffectiveModuleConfig {
  config: unknown;
  isEnabled: boolean;
}

export type EffectiveConfigsByModule = Partial<
  Record<StatutoryModule, EffectiveModuleConfig | null>
>;

export interface OverlaidSettings {
  financialYearStartMonth: number;
  processingDay: number;
  paymentDay: number;
  roundingRule: string;
  roundingDecimals: number;

  pfEnabled: boolean;
  esiEnabled: boolean;
  ptEnabled: boolean;
  lwfEnabled: boolean;
  npsEnabled: boolean;
  gratuityEnabled: boolean;
  bonusEnabled: boolean;
  incomeTaxEnabled: boolean;
  employerInsuranceEnabled: boolean;

  pfEmployeeRate: number;
  pfEmployerRate: number;
  pfWageCeiling: number;
  esiEmployeeRate: number;
  esiEmployerRate: number;
  esiWageCeiling: number;
  ptSlabs: PtSlab[];

  lwfEmployeeAmount: number;
  lwfEmployerAmount: number;
  // Defaults to [6, 12] (the old system's hardcoded LWF_MONTHS fallback)
  // when no LWF StatutoryConfigVersion exists yet — not a PayrollSettings
  // column, this fallback lives here.
  lwfMonths: number[];

  npsEmployerRate: number;
  gratuityRate: number;

  // Not a PayrollSettings column — only ever set when a payroll_calendar
  // version exists, carried through for parity with the old system.
  payrollFrequency?: string;
}

const DEFAULT_LWF_MONTHS = [6, 12];

export function applyStatutoryOverrides(
  settings: PayrollSettings,
  effectiveConfigs: EffectiveConfigsByModule,
): OverlaidSettings {
  const resolved: OverlaidSettings = {
    financialYearStartMonth: settings.financialYearStartMonth,
    processingDay: settings.processingDay,
    paymentDay: settings.paymentDay,
    roundingRule: settings.roundingRule,
    roundingDecimals: settings.roundingDecimals,
    pfEnabled: settings.pfEnabled,
    esiEnabled: settings.esiEnabled,
    ptEnabled: settings.ptEnabled,
    lwfEnabled: settings.lwfEnabled,
    npsEnabled: settings.npsEnabled,
    gratuityEnabled: settings.gratuityEnabled,
    bonusEnabled: settings.bonusEnabled,
    incomeTaxEnabled: settings.incomeTaxEnabled,
    employerInsuranceEnabled: settings.employerInsuranceEnabled,
    pfEmployeeRate: settings.pfEmployeeRate,
    pfEmployerRate: settings.pfEmployerRate,
    pfWageCeiling: settings.pfWageCeiling,
    esiEmployeeRate: settings.esiEmployeeRate,
    esiEmployerRate: settings.esiEmployerRate,
    esiWageCeiling: settings.esiWageCeiling,
    ptSlabs: settings.ptSlabs as unknown as PtSlab[],
    lwfEmployeeAmount: settings.lwfEmployeeAmount,
    lwfEmployerAmount: settings.lwfEmployerAmount,
    lwfMonths: DEFAULT_LWF_MONTHS,
    npsEmployerRate: settings.npsEmployerRate,
    gratuityRate: settings.gratuityRate,
  };

  const pf = effectiveConfigs.PF;
  if (pf) {
    const c = pf.config as {
      employeeRate: number;
      employerRate: number;
      wageCeiling: number;
    };
    resolved.pfEmployeeRate = c.employeeRate;
    resolved.pfEmployerRate = c.employerRate;
    resolved.pfWageCeiling = c.wageCeiling;
    resolved.pfEnabled = pf.isEnabled;
  }

  const esi = effectiveConfigs.ESI;
  if (esi) {
    const c = esi.config as {
      employeeRate: number;
      employerRate: number;
      wageCeiling: number;
    };
    resolved.esiEmployeeRate = c.employeeRate;
    resolved.esiEmployerRate = c.employerRate;
    resolved.esiWageCeiling = c.wageCeiling;
    resolved.esiEnabled = esi.isEnabled;
  }

  const pt = effectiveConfigs.PT;
  if (pt) {
    const c = pt.config as { slabs: PtSlab[] };
    resolved.ptSlabs = c.slabs;
    resolved.ptEnabled = pt.isEnabled;
  }

  const lwf = effectiveConfigs.LWF;
  if (lwf) {
    const c = lwf.config as {
      employeeAmount: number;
      employerAmount: number;
      months: number[];
    };
    resolved.lwfEmployeeAmount = c.employeeAmount;
    resolved.lwfEmployerAmount = c.employerAmount;
    resolved.lwfMonths = c.months;
    resolved.lwfEnabled = lwf.isEnabled;
  }

  const gratuity = effectiveConfigs.GRATUITY;
  if (gratuity) {
    const c = gratuity.config as { rate: number };
    resolved.gratuityRate = c.rate;
    resolved.gratuityEnabled = gratuity.isEnabled;
  }

  const bonus = effectiveConfigs.BONUS;
  if (bonus) {
    resolved.bonusEnabled = bonus.isEnabled;
  }

  const nps = effectiveConfigs.NPS;
  if (nps) {
    const c = nps.config as { employerRate: number };
    resolved.npsEmployerRate = c.employerRate;
    resolved.npsEnabled = nps.isEnabled;
  }

  const rounding = effectiveConfigs.ROUNDING;
  if (rounding) {
    const c = rounding.config as { rule: string; decimals: number };
    resolved.roundingRule = c.rule;
    resolved.roundingDecimals = c.decimals;
  }

  const payrollCalendar = effectiveConfigs.PAYROLL_CALENDAR;
  if (payrollCalendar) {
    const c = payrollCalendar.config as {
      frequency: string;
      processingDay: number;
      paymentDay: number;
    };
    resolved.payrollFrequency = c.frequency;
    resolved.processingDay = c.processingDay;
    resolved.paymentDay = c.paymentDay;
  }

  return resolved;
}

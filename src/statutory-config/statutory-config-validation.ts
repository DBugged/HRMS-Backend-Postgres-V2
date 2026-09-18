import { StatutoryModule } from '@prisma/client';
import { isIndianState } from '../common/indian-states';

/**
 * Pure port of the old backend's `utils/statutoryValidation.js` — one
 * validator per statutory module, ported verbatim (rate bounds, slab
 * monotonicity, day/decimal ranges). Throws a plain Error with a
 * user-facing message on invalid input; the service wraps that as a
 * BadRequestException.
 */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isPercent(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 100;
}
function isNonNegative(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function validatePfOrEsi(config: unknown): void {
  const c = config as {
    employeeRate?: unknown;
    employerRate?: unknown;
    wageCeiling?: unknown;
    applyFiftyPercentRule?: unknown;
    edliRate?: unknown;
    adminChargeRate?: unknown;
    epsRate?: unknown;
    edliMaxAmount?: unknown;
  };
  if (!isPercent(c.employeeRate))
    throw new Error('employeeRate must be a number between 0 and 100.');
  if (!isPercent(c.employerRate))
    throw new Error('employerRate must be a number between 0 and 100.');
  if (!isNonNegative(c.wageCeiling))
    throw new Error('wageCeiling must be a non-negative number.');
  validateOptionalBoolean(c.applyFiftyPercentRule, 'applyFiftyPercentRule');
  validateEdliMax(c.edliMaxAmount);
  for (const key of ['edliRate', 'adminChargeRate', 'epsRate'] as const) {
    if (c[key] !== undefined && !isPercent(c[key]))
      throw new Error(`${key} must be a number between 0 and 100.`);
  }
}

// Statutory cap on the monthly EDLI contribution (₹75 today); editable because it moves with the PF wage ceiling.
function validateEdliMax(v: unknown): void {
  if (v !== undefined && !isNonNegative(v))
    throw new Error('edliMaxAmount must be a non-negative number.');
}

function validateOptionalBoolean(v: unknown, name: string): void {
  if (v !== undefined && typeof v !== 'boolean')
    throw new Error(`${name} must be true or false.`);
}

// One slab ladder. `februaryAmount` is optional: some states charge a different amount in February (e.g.
// Maharashtra and Karnataka ₹300 vs ₹200) so the year lands on the statutory cap.
function validatePtSlabs(slabs: unknown, label: string): void {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    throw new Error(`${label} requires at least one slab.`);
  }
  let previousUpTo = -Infinity;
  slabs.forEach((slab, i) => {
    const s = slab as {
      upTo?: unknown;
      amount?: unknown;
      februaryAmount?: unknown;
    };
    if (!isNonNegative(s.amount)) {
      throw new Error(
        `${label} slab ${i + 1}: amount must be a non-negative number.`,
      );
    }
    if (s.februaryAmount !== undefined && !isNonNegative(s.februaryAmount)) {
      throw new Error(
        `${label} slab ${i + 1}: februaryAmount must be a non-negative number.`,
      );
    }
    const isLast = i === slabs.length - 1;
    if (s.upTo === null) {
      if (!isLast)
        throw new Error(
          `${label}: only the last slab may have upTo: null ("and above").`,
        );
      return;
    }
    if (!isNonNegative(s.upTo)) {
      throw new Error(
        `${label} slab ${i + 1}: upTo must be a non-negative number or null.`,
      );
    }
    if (s.upTo <= previousUpTo) {
      throw new Error(
        `${label} slabs must have strictly ascending upTo values.`,
      );
    }
    previousUpTo = s.upTo;
  });
}

// `slabs` is the org-wide default ladder, with an optional `womenSlabs` (e.g. Maharashtra exempts women up to
// ₹25,000). `stateRates` optionally overrides both per state (matched to the state of an employee's work location).
function validatePt(config: unknown): void {
  const c = config as {
    slabs?: unknown;
    womenSlabs?: unknown;
    stateRates?: unknown;
  };
  validatePtSlabs(c.slabs, 'pt');
  if (c.womenSlabs !== undefined) validatePtSlabs(c.womenSlabs, 'pt (women)');
  if (c.stateRates === undefined) return;
  if (!Array.isArray(c.stateRates))
    throw new Error('stateRates must be an array.');
  const seen = new Set<string>();
  for (const entry of c.stateRates as {
    state?: unknown;
    slabs?: unknown;
    womenSlabs?: unknown;
  }[]) {
    if (entry === null || typeof entry !== 'object')
      throw new Error('Each stateRates entry must be an object.');
    if (!isIndianState(entry.state))
      throw new Error('Each stateRates entry needs a valid Indian state name.');
    if (seen.has(entry.state))
      throw new Error(`stateRates has more than one entry for ${entry.state}.`);
    seen.add(entry.state);
    validatePtSlabs(entry.slabs, `pt ${entry.state}`);
    if (entry.womenSlabs !== undefined)
      validatePtSlabs(entry.womenSlabs, `pt ${entry.state} (women)`);
  }
}

// One LWF rate: fixed rupee amounts per deduction month, same shape as the org-wide default.
function validateLwfRate(c: {
  employeeAmount?: unknown;
  employerAmount?: unknown;
  months?: unknown;
}): void {
  if (!isNonNegative(c.employeeAmount))
    throw new Error('employeeAmount must be a non-negative number.');
  if (!isNonNegative(c.employerAmount))
    throw new Error('employerAmount must be a non-negative number.');
  if (
    !Array.isArray(c.months) ||
    !c.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)
  ) {
    throw new Error('months must be an array of integers between 1 and 12.');
  }
}

// The top-level fields are the default rate (used for any employee whose work-location state has no entry
// below, or who has no state). `stateRates` is optional: one entry per Indian state that has its own rate.
function validateLwf(config: unknown): void {
  const c = config as {
    employeeAmount?: unknown;
    employerAmount?: unknown;
    months?: unknown;
    stateRates?: unknown;
  };
  validateLwfRate(c);
  if (c.stateRates === undefined) return;
  if (!Array.isArray(c.stateRates))
    throw new Error('stateRates must be an array.');
  const seen = new Set<string>();
  for (const entry of c.stateRates as {
    state?: unknown;
    employeeAmount?: unknown;
    employerAmount?: unknown;
    months?: unknown;
  }[]) {
    if (entry === null || typeof entry !== 'object')
      throw new Error('Each stateRates entry must be an object.');
    if (!isIndianState(entry.state))
      throw new Error('Each stateRates entry needs a valid Indian state name.');
    if (seen.has(entry.state))
      throw new Error(`stateRates has more than one entry for ${entry.state}.`);
    seen.add(entry.state);
    validateLwfRate(entry);
  }
}

function validateGratuity(config: unknown): void {
  const c = config as { rate?: unknown; applyFiftyPercentRule?: unknown };
  if (!isNonNegative(c.rate))
    throw new Error('rate must be a non-negative number.');
  validateOptionalBoolean(c.applyFiftyPercentRule, 'applyFiftyPercentRule');
}

// Payment of Bonus Act (now Chapter VIII of the Code on Wages): bonus is 8.33%-20% of the wage base, only for
// employees whose Basic + DA is within the eligibility ceiling, and the base itself is capped at a calculation
// ceiling — higher of ₹7,000 or the applicable minimum wage, which the admin sets. All three are optional so an
// org that only ever switched the module on keeps working.
function validateBonus(config: unknown): void {
  const c = config as {
    rate?: unknown;
    eligibilityCeiling?: unknown;
    calculationCeiling?: unknown;
  };
  if (
    c.rate !== undefined &&
    !(isFiniteNumber(c.rate) && c.rate >= 8.33 && c.rate <= 20)
  )
    throw new Error('rate must be between 8.33 and 20 (Payment of Bonus Act).');
  for (const key of ['eligibilityCeiling', 'calculationCeiling'] as const) {
    if (c[key] !== undefined && !isNonNegative(c[key]))
      throw new Error(`${key} must be a non-negative number.`);
  }
}

function validateNps(config: unknown): void {
  const c = config as { employerRate?: unknown };
  if (!isPercent(c.employerRate))
    throw new Error('employerRate must be a number between 0 and 100.');
}

function validatePayrollCalendar(config: unknown): void {
  const c = config as {
    frequency?: unknown;
    processingDay?: unknown;
    paymentDay?: unknown;
  };
  if (c.frequency !== 'monthly')
    throw new Error('frequency must be "monthly" (the only supported value).');
  for (const [key, value] of [
    ['processingDay', c.processingDay],
    ['paymentDay', c.paymentDay],
  ] as const) {
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > 31
    ) {
      throw new Error(`${key} must be an integer between 0 and 31.`);
    }
  }
}

const ROUNDING_RULES = new Set(['nearest', 'up', 'down', 'none']);
function validateRounding(config: unknown): void {
  const c = config as { rule?: unknown; decimals?: unknown };
  if (typeof c.rule !== 'string' || !ROUNDING_RULES.has(c.rule)) {
    throw new Error('rule must be one of nearest, up, down, none.');
  }
  if (
    !Number.isInteger(c.decimals) ||
    (c.decimals as number) < 0 ||
    (c.decimals as number) > 4
  ) {
    throw new Error('decimals must be an integer between 0 and 4.');
  }
}

const VALIDATORS: Record<StatutoryModule, (config: unknown) => void> = {
  [StatutoryModule.PF]: validatePfOrEsi,
  [StatutoryModule.ESI]: validatePfOrEsi,
  [StatutoryModule.PT]: validatePt,
  [StatutoryModule.LWF]: validateLwf,
  [StatutoryModule.GRATUITY]: validateGratuity,
  [StatutoryModule.BONUS]: validateBonus,
  [StatutoryModule.NPS]: validateNps,
  [StatutoryModule.PAYROLL_CALENDAR]: validatePayrollCalendar,
  [StatutoryModule.ROUNDING]: validateRounding,
};

export function validateModuleConfig(
  module: StatutoryModule,
  config: unknown,
): void {
  if (config === null || typeof config !== 'object') {
    throw new Error('config must be an object.');
  }
  VALIDATORS[module](config);
}

// The 9 seed values from the old system's seedStatutoryConfig.js —
// payroll_calendar/rounding are operational config, always enabled;
// everything else is a compliance opt-in, disabled by default.
export const SEED_DEFAULTS: Record<
  StatutoryModule,
  { config: object; isEnabled: boolean }
> = {
  [StatutoryModule.PF]: {
    // EPFO raised the mandatory PF wage ceiling from 15,000 to 25,000 effective 17-Sep-2026 (Cabinet
    // approval), so new orgs start at the current ceiling. Existing orgs keep their stored version and
    // are prompted in the Statutory Compliance Center to add a new one.
    config: {
      employeeRate: 12,
      employerRate: 12,
      wageCeiling: 25000,
      edliRate: 0.5,
      adminChargeRate: 0.5,
      epsRate: 8.33,
      edliMaxAmount: 75,
    },
    isEnabled: false,
  },
  [StatutoryModule.ESI]: {
    config: { employeeRate: 0.75, employerRate: 3.25, wageCeiling: 21000 },
    isEnabled: false,
  },
  [StatutoryModule.PT]: {
    config: {
      slabs: [
        { upTo: 7500, amount: 0 },
        { upTo: 10000, amount: 175 },
        // Maharashtra charges ₹300 in February so the year totals its ₹2,500 cap.
        { upTo: null, amount: 200, februaryAmount: 300 },
      ],
      // Maharashtra exempts women up to ₹25,000 a month; ₹200 (₹300 in February) above.
      womenSlabs: [
        { upTo: 25000, amount: 0 },
        { upTo: null, amount: 200, februaryAmount: 300 },
      ],
    },
    isEnabled: false,
  },
  [StatutoryModule.LWF]: {
    config: { employeeAmount: 25, employerAmount: 75, months: [6, 12] },
    isEnabled: false,
  },
  [StatutoryModule.GRATUITY]: {
    config: { rate: 4.81 },
    isEnabled: false,
  },
  [StatutoryModule.BONUS]: {
    config: { rate: 8.33, eligibilityCeiling: 21000, calculationCeiling: 7000 },
    isEnabled: false,
  },
  [StatutoryModule.NPS]: {
    config: { employerRate: 10 },
    isEnabled: false,
  },
  [StatutoryModule.PAYROLL_CALENDAR]: {
    config: { frequency: 'monthly', processingDay: 0, paymentDay: 0 },
    isEnabled: true,
  },
  [StatutoryModule.ROUNDING]: {
    config: { rule: 'nearest', decimals: 0 },
    isEnabled: true,
  },
};

import { StatutoryModule } from '@prisma/client';

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
  };
  if (!isPercent(c.employeeRate))
    throw new Error('employeeRate must be a number between 0 and 100.');
  if (!isPercent(c.employerRate))
    throw new Error('employerRate must be a number between 0 and 100.');
  if (!isNonNegative(c.wageCeiling))
    throw new Error('wageCeiling must be a non-negative number.');
}

function validatePt(config: unknown): void {
  const c = config as { slabs?: unknown };
  if (!Array.isArray(c.slabs) || c.slabs.length === 0) {
    throw new Error('pt config requires at least one slab.');
  }
  let previousUpTo = -Infinity;
  c.slabs.forEach((slab, i) => {
    const s = slab as { upTo?: unknown; amount?: unknown };
    if (!isNonNegative(s.amount)) {
      throw new Error(
        `pt slab ${i + 1}: amount must be a non-negative number.`,
      );
    }
    const isLast = i === (c.slabs as unknown[]).length - 1;
    if (s.upTo === null) {
      if (!isLast)
        throw new Error(
          'pt: only the last slab may have upTo: null ("and above").',
        );
      return;
    }
    if (!isNonNegative(s.upTo)) {
      throw new Error(
        `pt slab ${i + 1}: upTo must be a non-negative number or null.`,
      );
    }
    if (s.upTo <= previousUpTo) {
      throw new Error('pt slabs must have strictly ascending upTo values.');
    }
    previousUpTo = s.upTo;
  });
}

function validateLwf(config: unknown): void {
  const c = config as {
    employeeAmount?: unknown;
    employerAmount?: unknown;
    months?: unknown;
  };
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

function validateGratuity(config: unknown): void {
  const c = config as { rate?: unknown };
  if (!isNonNegative(c.rate))
    throw new Error('rate must be a non-negative number.');
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
  [StatutoryModule.BONUS]: () => {
    /* no fields today — isEnabled on the version row is the entire config */
  },
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
    config: { employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
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
        { upTo: null, amount: 200 },
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
    config: {},
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

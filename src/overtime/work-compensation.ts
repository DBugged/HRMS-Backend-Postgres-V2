// Purpose: How work on a weekly off / holiday is compensated: comp-off days, days of pay, or both.
// Responsibilities: The option list an organisation can configure (PayrollSettings.workCompensation), its defaults and
//   validation, and resolving the option chosen when an overtime record is approved.
// Important: Pay days are paid as days (full-month Basic / 30 each, through OT_DAY_PAY_DAYS); comp-off days become a
//   real comp-off balance. A record with no option stays on the hourly rate (hours x multiplier).
import { BadRequestException } from '@nestjs/common';

export interface WorkCompensationOption {
  key: string;
  label: string;
  /** Days of comp-off added to the leave balance. */
  compOffDays: number;
  /** Days of pay added to payroll. */
  payDays: number;
}

export interface WorkCompensationSettings {
  /** Option used when the approver does not pick one. null = the hourly rate. */
  defaultKey: string | null;
  options: WorkCompensationOption[];
}

// The starting list: the usual shapes of compensation, with the days at 0 so that nothing is promised until the
// organization sets what it actually grants. An option with 0 comp-off days and 0 pay days is never offered to an
// approver (see selectableWorkCompensation), so an organization that has not configured this keeps the hourly rate.
export const DEFAULT_WORK_COMPENSATION_OPTIONS: WorkCompensationOption[] = [
  { key: 'COMP_OFF', label: 'Comp-off (1 day)', compOffDays: 0, payDays: 0 },
  { key: 'PAY_1', label: '1 day pay', compOffDays: 0, payDays: 0 },
  { key: 'PAY_2', label: '2 days pay', compOffDays: 0, payDays: 0 },
  {
    key: 'COMP_OFF_PAY_1',
    label: 'Comp-off + 1 day pay',
    compOffDays: 0,
    payDays: 0,
  },
  {
    key: 'COMP_OFF_PAY_2',
    label: 'Comp-off + 2 days pay',
    compOffDays: 0,
    payDays: 0,
  },
];

const MAX_OPTIONS = 20;
const MAX_DAYS = 10;

/** The stored JSON as a usable settings object: the built-in options when none were saved. */
export function resolveWorkCompensation(
  stored: unknown,
): WorkCompensationSettings {
  const raw = (stored ?? {}) as Partial<WorkCompensationSettings>;
  const options =
    Array.isArray(raw.options) && raw.options.length > 0
      ? raw.options
      : DEFAULT_WORK_COMPENSATION_OPTIONS;
  const defaultKey =
    typeof raw.defaultKey === 'string' &&
    options.some((o) => o.key === raw.defaultKey)
      ? raw.defaultKey
      : null;
  return { defaultKey, options };
}

/**
 * What an approver may actually choose: the options that grant something (some comp-off or pay days). A 0 / 0 option is
 * a placeholder. The default is dropped when it is one of those.
 */
export function selectableWorkCompensation(
  settings: WorkCompensationSettings,
): WorkCompensationSettings {
  const options = settings.options.filter(
    (o) => Number(o.compOffDays) > 0 || Number(o.payDays) > 0,
  );
  const defaultKey =
    settings.defaultKey && options.some((o) => o.key === settings.defaultKey)
      ? settings.defaultKey
      : null;
  return { defaultKey, options };
}

/** Rejects a malformed option list; returns the cleaned value to store. */
export function assertValidWorkCompensation(
  value: unknown,
): WorkCompensationSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('workCompensation must be an object.');
  }
  const input = value as {
    defaultKey?: unknown;
    options?: unknown;
  };
  if (!Array.isArray(input.options)) {
    throw new BadRequestException(
      'workCompensation.options must be a list of options.',
    );
  }
  if (input.options.length === 0 || input.options.length > MAX_OPTIONS) {
    throw new BadRequestException(
      `Add between 1 and ${MAX_OPTIONS} compensation options.`,
    );
  }
  const seen = new Set<string>();
  const options = input.options.map((raw, index) => {
    const o = raw as Partial<WorkCompensationOption>;
    const where = `Compensation option ${index + 1}`;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!/^[A-Z0-9_]{1,40}$/.test(key)) {
      throw new BadRequestException(
        `${where}: the key must be 1-40 capital letters, digits or underscores.`,
      );
    }
    if (seen.has(key)) {
      throw new BadRequestException(`${where}: the key ${key} is used twice.`);
    }
    seen.add(key);
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label || label.length > 60) {
      throw new BadRequestException(
        `${where}: a name of up to 60 characters is required.`,
      );
    }
    const compOffDays = Number(o.compOffDays ?? 0);
    const payDays = Number(o.payDays ?? 0);
    for (const [name, days] of [
      ['comp-off days', compOffDays],
      ['pay days', payDays],
    ] as const) {
      if (!Number.isFinite(days) || days < 0 || days > MAX_DAYS) {
        throw new BadRequestException(
          `${where}: ${name} must be between 0 and ${MAX_DAYS}.`,
        );
      }
      if (Math.round(days * 2) !== days * 2) {
        throw new BadRequestException(
          `${where}: ${name} must be in steps of half a day.`,
        );
      }
    }
    // 0 and 0 is allowed: it is a placeholder that is kept but never offered to an approver (selectableWorkCompensation).
    return { key, label, compOffDays, payDays };
  });
  const defaultKey =
    input.defaultKey === null ||
    input.defaultKey === undefined ||
    input.defaultKey === ''
      ? null
      : String(input.defaultKey);
  if (defaultKey !== null && !seen.has(defaultKey)) {
    throw new BadRequestException(
      'The default option is not one of the options.',
    );
  }
  return { defaultKey, options };
}

/** The option an approval uses: the one asked for, else the default; null = hourly rate. */
export function pickWorkCompensation(
  settings: WorkCompensationSettings,
  requestedKey: string | undefined,
): WorkCompensationOption | null {
  const key = requestedKey || settings.defaultKey;
  if (!key) return null;
  const option = settings.options.find((o) => o.key === key);
  if (!option) {
    throw new BadRequestException(
      'That compensation option is not available. Choose one from the list.',
    );
  }
  return option;
}

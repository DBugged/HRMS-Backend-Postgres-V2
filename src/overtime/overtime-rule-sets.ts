// Purpose: Named overtime rule sets ("Factory floor", "Office staff") that an Admin assigns to departments, employee
//   types or individual people, on top of the company overtime policy.
// Responsibilities: pickRuleSet finds the set that applies to a person on a date; applyRuleSetPolicy / applyRuleSetRates
//   lay its values over the company policy and pay multipliers; sanitizeRuleSetInput validates what an Admin saves.
// Important: precedence is the person's own assignment, then their department, then their employee type; within one
//   level the set with the latest effectiveFrom wins. A key left out of a set falls back to the company value, so a set
//   only needs to state what differs. A set only counts for dates on or after effectiveFrom, so changing rules never
//   rewrites an earlier month.
import { BadRequestException } from '@nestjs/common';
import { OvertimeType } from '@prisma/client';
import { resolveOvertimePolicy, type OvertimePolicy } from './overtime-policy';

export interface RuleSetRow {
  id: string;
  name: string;
  policy: unknown;
  rates: unknown;
  employeeIds: string[];
  departmentIds: string[];
  employeeTypes: string[];
  designations?: string[];
  effectiveFrom: string;
  isActive: boolean;
}

export interface RuleSetPerson {
  id: string;
  departmentId?: string | null;
  employeeType?: string | null;
  designation?: string | null;
}

export function pickRuleSet<T extends RuleSetRow>(
  rows: T[] | null | undefined,
  person: RuleSetPerson,
  date: string,
): T | null {
  if (!rows?.length) return null;
  const live = rows.filter((r) => r.isActive && r.effectiveFrom <= date);
  const latest = (list: T[]) =>
    list.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ??
    null;
  return (
    latest(live.filter((r) => r.employeeIds.includes(person.id))) ??
    latest(
      live.filter(
        (r) =>
          !!person.departmentId &&
          r.departmentIds.includes(person.departmentId),
      ),
    ) ??
    latest(
      live.filter(
        (r) =>
          !!person.designation &&
          (r.designations ?? []).includes(person.designation),
      ),
    ) ??
    latest(
      live.filter(
        (r) =>
          !!person.employeeType &&
          r.employeeTypes.includes(person.employeeType),
      ),
    )
  );
}

export function applyRuleSetPolicy(
  base: OvertimePolicy,
  set: Pick<RuleSetRow, 'policy'> | null,
): OvertimePolicy {
  if (!set || !set.policy || typeof set.policy !== 'object') return base;
  return resolveOvertimePolicy({
    overtimePolicy: { ...base, ...(set.policy as Record<string, unknown>) },
  });
}

const RATE_KEYS: OvertimeType[] = [
  OvertimeType.REGULAR,
  OvertimeType.WEEKEND,
  OvertimeType.HOLIDAY,
  OvertimeType.NIGHT,
];

// `minimum` is the legal floor (Code on Wages), so a set can raise a rate but never push it under it.
export function applyRuleSetRates(
  base: Record<OvertimeType, number>,
  set: Pick<RuleSetRow, 'rates'> | null,
  minimum: number,
): Record<OvertimeType, number> {
  if (!set || !set.rates || typeof set.rates !== 'object') return base;
  const out = { ...base };
  for (const k of RATE_KEYS) {
    const v = (set.rates as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v))
      out[k] = Math.max(v, minimum);
  }
  return out;
}

const bad = (m: string): never => {
  throw new BadRequestException(m);
};

function numberIn(
  o: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  opts: { integer?: boolean; nullable?: boolean } = {},
) {
  const v = o[key];
  if (v === undefined) return;
  if (v === null) {
    if (!opts.nullable) bad(`${key} cannot be empty.`);
    return;
  }
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    v < min ||
    v > max ||
    (opts.integer && !Number.isInteger(v))
  ) {
    bad(
      `${key} must be ${opts.integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`,
    );
  }
}

// Only known keys survive; anything else is dropped so a set never carries stray settings.
export function sanitizeRuleSetPolicy(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    bad('policy must be an object.');
  const o = raw as Record<string, unknown>;
  numberIn(o, 'minMinutes', 0, 240, { integer: true });
  numberIn(o, 'minWorkedHours', 0.5, 24, { nullable: true });
  numberIn(o, 'startAfterMinutes', 0, 240, { integer: true });
  numberIn(o, 'maxHoursPerQuarter', 1, 2232, { nullable: true });
  numberIn(o, 'autoApproveMonthlyCapHours', 0.25, 744, { nullable: true });
  if (o.eligible !== undefined && typeof o.eligible !== 'boolean')
    bad('eligible must be true or false.');
  for (const k of ['nightStart', 'nightEnd']) {
    const v = o[k];
    if (v !== undefined && v !== null && !(typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)))
      bad(`${k} must be a time like 22:00.`);
  }
  if (!!o.nightStart !== !!o.nightEnd)
    bad('Set both the start and the end of the night window, or neither.');
  if (o.dayRules !== undefined) {
    const dr = o.dayRules;
    if (!dr || typeof dr !== 'object' || Array.isArray(dr)) bad('dayRules must be an object.');
    for (const [k, v] of Object.entries(dr as Record<string, unknown>)) {
      if (!['REGULAR', 'WEEKEND', 'HOLIDAY', 'NIGHT'].includes(k)) bad(`dayRules.${k} is not a day type.`);
      if (!v || typeof v !== 'object') bad(`dayRules.${k} must be an object.`);
      numberIn(v as Record<string, unknown>, 'minMinutes', 0, 240, { integer: true, nullable: true });
      numberIn(v as Record<string, unknown>, 'minWorkedHours', 0.5, 24, { nullable: true });
    }
  }
  numberIn(o, 'maxHoursPerDay', 0.25, 24, { nullable: true });
  numberIn(o, 'maxHoursPerMonth', 0.25, 744, { nullable: true });
  numberIn(o, 'claimWithinDays', 1, 90, { integer: true, nullable: true });
  const oneOf = (k: string, allowed: unknown[]) => {
    if (o[k] !== undefined && !allowed.includes(o[k]))
      bad(`${k} must be one of ${allowed.join(', ')}.`);
  };
  oneOf('roundingMinutes', [0, 15, 30, 60]);
  oneOf('roundingMode', ['DOWN', 'NEAREST', 'UP']);
  oneOf('capMode', ['BLOCK', 'WARN']);
  oneOf('creationMode', ['BOTH', 'SELF', 'AUTO']);
  oneOf('compensationMode', ['ANY', 'PAY', 'COMP_OFF']);
  oneOf('autoApprove', ['COMPANY', 'ON', 'OFF']);
  oneOf('approvalLevel', ['MANAGER', 'HR']);
  const keys = [
    'minMinutes',
    'roundingMinutes',
    'roundingMode',
    'minWorkedHours',
    'maxHoursPerDay',
    'maxHoursPerMonth',
    'capMode',
    'claimWithinDays',
    'creationMode',
    'eligible',
    'startAfterMinutes',
    'maxHoursPerQuarter',
    'compensationMode',
    'autoApprove',
    'autoApproveMonthlyCapHours',
    'approvalLevel',
    'nightStart',
    'nightEnd',
    'dayRules',
  ];
  return Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  );
}

export function sanitizeRuleSetRates(
  raw: unknown,
  minimum: number,
): Record<string, number> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    bad('rates must be an object.');
  const o = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of RATE_KEYS) {
    const v = o[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v > 10)
      bad(`${k.toLowerCase()} rate must be a number up to 10.`);
    if ((v as number) < minimum)
      bad(
        `${k.toLowerCase()} rate cannot be below ${minimum}x (the legal minimum for overtime).`,
      );
    out[k] = v as number;
  }
  return Object.keys(out).length ? out : null;
}

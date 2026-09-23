// Purpose: Type/shape and range validation for PATCH /organizations/settings/:section bodies, plus the
// deep-merge used to apply partial JSON-blob updates.
// Responsibilities: Rejects wrong-typed values with a field-level 400 before they can reach Prisma (which
// would otherwise throw an unhandled 500, or — for a JSON column like documentNumbering — silently accept a
// bare string and permanently corrupt the org's config). Normalizes numeric-string inputs to numbers.
// Important: validation only looks at the keys actually present in the incoming body — legacy stored data
// is never re-validated on an unrelated save.
import { BadRequestException } from '@nestjs/common';
import { isIanaTimeZone } from '../common/is-iana-timezone.validator';

// Number of Setup Wizard steps (frontend/src/components/organization/
// steps.js ORG_STEPS) — setupStep is 1-based and the wizard clamps it to
// this count itself.
export const WIZARD_STEP_COUNT = 7;

type FieldKind =
  | 'string' // nullable string column
  | 'requiredString' // non-nullable string column (null would 500 in Prisma)
  | 'fileUrl' // branding/seal URL — string or null, resolved separately
  | 'boolean'
  | 'object' // JSON column holding a plain object — deep-merged on write
  | 'array'; // JSON column holding an array — replaced wholesale

// Expected kind for every field that appears in SECTION_FIELDS.
export const FIELD_KINDS: Record<string, FieldKind> = {
  companyName: 'string',
  legalName: 'string',
  tagline: 'string',
  description: 'string',
  companyLogoUrl: 'fileUrl',
  assetMeta: 'object',
  gstin: 'string',
  pan: 'string',
  tan: 'string',
  cin: 'string',
  registrationNumber: 'string',
  lin: 'string',
  msmeRegistrationNumber: 'string',
  epfoEstablishmentCode: 'string',
  esicEmployerCode: 'string',
  ptRegistrationNumber: 'string',
  labourLicenseNumber: 'string',
  registeredAddress: 'string',
  corporateAddress: 'string',
  city: 'string',
  state: 'string',
  country: 'requiredString',
  pincode: 'string',
  phone: 'string',
  mobile: 'string',
  contactEmail: 'string',
  website: 'string',
  primaryColor: 'requiredString',
  secondaryColor: 'requiredString',
  faviconUrl: 'fileUrl',
  reportLogoUrl: 'fileUrl',
  emailLogoUrl: 'fileUrl',
  watermarkLogo: 'boolean',
  signatories: 'array',
  sealUrl: 'fileUrl',
  policies: 'object',
  orgPayrollAttendancePrefs: 'object',
  documentNumbering: 'object',
  customEmployeeTypes: 'array',
  enableWFH: 'boolean',
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// Recursive merge: plain objects merge key-by-key; arrays, primitives and
// null in `patch` replace whatever was there (so a client can still clear
// a key by sending null, and an array like weekendDays is set exactly).
export function deepMerge(
  base: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isPlainObject(value) && isPlainObject(out[key])
        ? deepMerge(out[key], value)
        : value;
  }
  return out;
}

function bad(message: string): never {
  throw new BadRequestException(message);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
  // '' / null accepted as "unset" (optional frontend inputs send '' when
  // cleared).
  allowEmpty?: boolean;
}

// Validates obj[key] if present; numeric strings are normalized to numbers
// in place.
function checkNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  rule: NumberRule,
) {
  if (!(key in obj)) return;
  const raw = obj[key];
  if (raw === undefined) return;
  if (raw === null || raw === '') {
    if (rule.allowEmpty) return;
    bad(`${path} is required and must be a number.`);
  }
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) bad(`${path} must be a number.`);
  if (rule.integer && !Number.isInteger(n)) {
    bad(`${path} must be a whole number.`);
  }
  if (rule.min !== undefined && n < rule.min) {
    bad(`${path} must be at least ${rule.min}.`);
  }
  if (rule.max !== undefined && n > rule.max) {
    bad(`${path} must be at most ${rule.max}.`);
  }
  obj[key] = n;
}

function checkTime(obj: Record<string, unknown>, key: string, path: string) {
  if (!(key in obj) || obj[key] === undefined) return;
  const v = obj[key];
  if (typeof v !== 'string' || !HHMM.test(v)) {
    bad(`${path} must be a time of day in HH:mm format (00:00-23:59).`);
  }
}

function validatePolicies(p: Record<string, unknown>) {
  checkNumber(
    p,
    'financialYearStartMonth',
    'policies.financialYearStartMonth',
    {
      min: 1,
      max: 12,
      integer: true,
    },
  );
  checkNumber(p, 'defaultNoticeDays', 'policies.defaultNoticeDays', {
    min: 0,
    integer: true,
  });
  if (p.timezone !== undefined && !isIanaTimeZone(p.timezone)) {
    bad('timezone must be a valid IANA timezone (e.g. Asia/Kolkata).');
  }
  for (const key of [
    'currency',
    'currencySymbol',
    'dateFormat',
    'timeFormat',
    'language',
  ]) {
    const v = p[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      bad(`policies.${key} must be a string.`);
    }
  }
  if (
    p.autoCarryForwardEnabled !== undefined &&
    typeof p.autoCarryForwardEnabled !== 'boolean'
  ) {
    bad('policies.autoCarryForwardEnabled must be true or false.');
  }
}

function validateAttendancePrefs(p: Record<string, unknown>) {
  const path = (k: string) => `orgPayrollAttendancePrefs.${k}`;
  checkTime(p, 'defaultShiftStartTime', path('defaultShiftStartTime'));
  checkTime(p, 'defaultShiftEndTime', path('defaultShiftEndTime'));
  for (const k of [
    'defaultLateInThresholdMinutes',
    'defaultEarlyOutThresholdMinutes',
  ]) {
    checkNumber(p, k, path(k), { min: 0 });
  }
  checkNumber(p, 'defaultBreakMinutes', path('defaultBreakMinutes'), {
    min: 0,
    allowEmpty: true,
  });
  for (const k of [
    'defaultMinHoursForPresent',
    'defaultMinHoursForHalfDay',
    'defaultWorkingHoursPerDay',
  ]) {
    checkNumber(p, k, path(k), { min: 0, max: 24 });
  }
  if (p.weekendDays !== undefined) {
    const w = p.weekendDays;
    if (
      !Array.isArray(w) ||
      !w.every(
        (d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
      )
    ) {
      bad(
        `${path('weekendDays')} must be an array of day numbers 0 (Sunday) to 6 (Saturday).`,
      );
    }
  }
}

function validateDocumentNumbering(n: Record<string, unknown>) {
  for (const [type, entry] of Object.entries(n)) {
    if (!isPlainObject(entry)) {
      bad(`documentNumbering.${type} must be an object.`);
    }
    if (
      entry.format !== undefined &&
      (typeof entry.format !== 'string' || !entry.format.trim())
    ) {
      bad(`documentNumbering.${type}.format must be a non-empty string.`);
    }
  }
}

// Throws BadRequestException on the first type/shape/range problem in
// `data` (already filtered to the section's whitelisted fields). Mutates
// numeric-string values into numbers.
export function validateSectionData(data: Record<string, unknown>) {
  for (const [field, value] of Object.entries(data)) {
    const kind = FIELD_KINDS[field];
    if (!kind || value === undefined) continue;
    switch (kind) {
      case 'string':
      case 'fileUrl':
        if (value !== null && typeof value !== 'string') {
          bad(`${field} must be a string.`);
        }
        break;
      case 'requiredString':
        if (typeof value !== 'string') bad(`${field} must be a string.`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') bad(`${field} must be true or false.`);
        break;
      case 'object':
        if (!isPlainObject(value)) bad(`${field} must be an object.`);
        break;
      case 'array':
        if (!Array.isArray(value)) bad(`${field} must be an array.`);
        break;
    }
  }

  for (const field of ['primaryColor', 'secondaryColor']) {
    const v = data[field];
    if (typeof v === 'string' && !HEX_COLOR.test(v)) {
      bad(`${field} must be a hex color (e.g. #5546e0).`);
    }
  }
  if (Array.isArray(data.signatories)) {
    if (!data.signatories.every(isPlainObject)) {
      bad('signatories must be an array of objects.');
    }
  }
  if (isPlainObject(data.policies)) validatePolicies(data.policies);
  if (isPlainObject(data.orgPayrollAttendancePrefs)) {
    validateAttendancePrefs(data.orgPayrollAttendancePrefs);
  }
  if (isPlainObject(data.documentNumbering)) {
    validateDocumentNumbering(data.documentNumbering);
  }
}

export function validateSetupStep(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > WIZARD_STEP_COUNT
  ) {
    bad(`setupStep must be a whole number from 1 to ${WIZARD_STEP_COUNT}.`);
  }
  return value;
}

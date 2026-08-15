// Format-validation regexes, ported verbatim from the old system's
// orgValidators.js/orgValidation.js (kept in sync there across client and
// server — here it's the single server-side source of truth). Empty/absent
// values always pass — individual fields are optional; only
// completeSetup()'s REQUIRED_FOR_COMPLETION set enforces non-blank.

export const ORG_FIELD_PATTERNS: Record<string, RegExp> = {
  gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]{1}$/,
  tan: /^[A-Z]{4}\d{5}[A-Z]{1}$/,
  cin: /^[LUlu]\d{5}[A-Za-z]{2}\d{4}[A-Za-z]{3}\d{6}$/,
  contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  website: /^https?:\/\/[^\s]+\.[^\s]+$/,
  phone: /^\+?\d[\d\s-]{6,14}\d$/,
  pincode: /^\d{6}$/,
};

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function validateOrgFields(
  data: Record<string, unknown>,
): string | null {
  for (const [field, pattern] of Object.entries(ORG_FIELD_PATTERNS)) {
    const value = data[field];
    if (typeof value === 'string' && value.trim() && !pattern.test(value)) {
      return `${field} is not in a valid format.`;
    }
  }
  return null;
}

export function validateIfsc(value: unknown): boolean {
  return typeof value !== 'string' || !value.trim() || IFSC_PATTERN.test(value);
}

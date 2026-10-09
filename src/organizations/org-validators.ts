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
  // An Indian PIN code is six digits and never starts with 0.
  pincode: /^[1-9]\d{5}$/,
  registrationNumber: /^[A-Za-z0-9][A-Za-z0-9\-/ .]{2,49}$/,
  lin: /^[A-Za-z0-9][A-Za-z0-9\-/ ]{2,24}$/,
  msmeRegistrationNumber: /^(UDYAM-[A-Z]{2}-\d{2}-\d{7}|[A-Za-z0-9-]{10,25})$/i,
  // EPFO establishment code: region+office (5 letters), establishment (7 digits), optional extension (3 digits).
  epfoEstablishmentCode: /^[A-Z]{5}\d{7}(\d{3})?$/,
  esicEmployerCode: /^(\d{10}|\d{17})$/,
  ptRegistrationNumber: /^[A-Za-z0-9]{8,20}$/,
  labourLicenseNumber: /^[A-Za-z0-9][A-Za-z0-9\-/ ]{2,29}$/,
};

// Free-text fields: a sensible length and no markup characters.
const TEXT_LIMITS: Record<string, number> = {
  companyName: 150,
  legalName: 150,
  tagline: 200,
  description: 1000,
  registeredAddress: 500,
  corporateAddress: 500,
  city: 100,
};

export function validateOrgFields(
  data: Record<string, unknown>,
): string | null {
  for (const [field, pattern] of Object.entries(ORG_FIELD_PATTERNS)) {
    const value = data[field];
    if (typeof value === 'string' && value.trim() && !pattern.test(value)) {
      return `${field} is not in a valid format.`;
    }
  }
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = data[field];
    if (typeof value !== 'string') continue;
    if (value.length > max) {
      return `${field} can be at most ${max} characters.`;
    }
    if (/[<>]/.test(value)) {
      return `${field} cannot contain < or > characters.`;
    }
  }
  // A GSTIN embeds the PAN of the registered entity (characters 3 to 12) - when both are given they must agree.
  const gstin = data.gstin;
  const pan = data.pan;
  if (
    typeof gstin === 'string' &&
    gstin.trim() &&
    typeof pan === 'string' &&
    pan.trim() &&
    gstin.slice(2, 12) !== pan
  ) {
    return 'gstin does not match the PAN - a GSTIN contains the PAN in characters 3 to 12.';
  }
  return null;
}

import { isValidIndianMobile } from '../common/indian-mobile';
import { BadRequestException } from '@nestjs/common';
import { isKeyAllowedForOrg, signFileToken } from '../files/file-token';
import { isValidCalendarDateString } from '../common/is-valid-calendar-date.validator';

// Format checks for the identifier fields inside personalData — these were
// previously free-text with no validation at all (any string, any length,
// any characters), unlike every other structured field in this codebase.
// Each pattern is the standard published format for that document; a blank
// value is always allowed since none of these fields are mandatory.
const IDENTIFIER_PATTERNS: Record<
  string,
  { pattern: RegExp; label: string; example: string }
> = {
  panNumber: {
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    label: 'PAN',
    example: 'ABCDE1234F',
  },
  // Stored/displayed with spaces (see Profile.tsx's "1234 5678 9012"
  // placeholder) — spaces are stripped before matching, not persisted
  // differently, since the merge below writes back whatever the caller
  // sent verbatim once it passes validation.
  aadharNumber: {
    pattern: /^[2-9][0-9]{11}$/,
    label: 'Aadhaar number',
    example: '234567890123',
  },
  uanNumber: {
    pattern: /^[0-9]{12}$/,
    label: 'UAN',
    example: '123456789012',
  },
  // Salary is transferred to these — a typo here sends pay to the wrong place, so the standard formats apply.
  bankIFSC: {
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    label: 'IFSC code',
    example: 'HDFC0001234',
  },
  bankAccountNo: {
    pattern: /^[0-9]{9,18}$/,
    label: 'bank account number',
    example: '123456789012',
  },
  // EPFO member account: region (2 letters) / office (3 letters) / establishment (7 digits) / extension (3 digits) /
  // account (7 digits), written with or without the slashes.
  pfNumber: {
    pattern: /^[A-Z]{2}\/?[A-Z]{2,3}\/?[0-9]{7}\/?[0-9]{3}\/?[0-9]{7}$/,
    label: 'PF number',
    example: 'MH/BAN/1234567/000/0001234',
  },
  esicNumber: {
    pattern: /^[0-9]{10}$/,
    label: 'ESIC number',
    example: '1234567890',
  },
  // Plain 10-digit Indian mobile numbers (they start with 6-9, never 0) — the employee's own Contact Number lives
  // on the User row (validated by @Matches on Create/UpdateEmployeeDto
  // instead), but these family/emergency contact numbers live in
  // personalData like the identifiers above, so they go through the same
  // validator.
  fatherContact: {
    pattern: /^[6-9][0-9]{9}$/,
    label: "Father's contact number",
    example: '9876543210',
  },
  motherContact: {
    pattern: /^[6-9][0-9]{9}$/,
    label: "Mother's contact number",
    example: '9876543210',
  },
  emergencyContact1Number: {
    pattern: /^[6-9][0-9]{9}$/,
    label: 'Emergency contact 1 number',
    example: '9876543210',
  },
  emergencyContact2Number: {
    pattern: /^[6-9][0-9]{9}$/,
    label: 'Emergency contact 2 number',
    example: '9876543210',
  },
};

const PHONE_KEYS = new Set([
  'fatherContact',
  'motherContact',
  'emergencyContact1Number',
  'emergencyContact2Number',
]);

// Throws on the first invalid identifier found in `patch` — called before
// merging a personalData patch onto the stored blob. Only checks fields
// actually present in this patch (a partial edit that doesn't touch PAN
// isn't re-validated against a possibly-already-invalid stored value).
// A postal address typed into one box: readable and printable on letters and exit documents (mirrors the frontend's
// src/utils/addressValidation.ts - the browser check is only a convenience, this is the one that holds).
export const ADDRESS_MIN_LENGTH = 10;
export const ADDRESS_MAX_LENGTH = 250;

export function assertValidAddress(patch: Record<string, unknown>): void {
  const value = patch.currentAddress;
  if (typeof value !== 'string') return;
  const address = value.trim();
  if (address === '') return;
  if (address.length < ADDRESS_MIN_LENGTH) {
    throw new BadRequestException(
      `Current Address is too short - enter the full address (at least ${ADDRESS_MIN_LENGTH} characters).`,
    );
  }
  if (address.length > ADDRESS_MAX_LENGTH) {
    throw new BadRequestException(
      `Current Address can be at most ${ADDRESS_MAX_LENGTH} characters (now ${address.length}).`,
    );
  }
}

export function assertValidIdentifiers(patch: Record<string, unknown>): void {
  assertValidAddress(patch);
  for (const [key, { pattern, label, example }] of Object.entries(
    IDENTIFIER_PATTERNS,
  )) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'string') continue;
    const normalized =
      key === 'aadharNumber' ? value.replace(/\s+/g, '') : value.trim();
    if (normalized === '') continue;
    // Phone fields: an Indian mobile number, written plain or with +91 (see common/indian-mobile.ts).
    if (PHONE_KEYS.has(key)) {
      if (!isValidIndianMobile(normalized)) {
        if (/^\+(?!\s*91)/.test(normalized)) {
          throw new BadRequestException(
            `Invalid ${label} — only Indian (+91) numbers are supported.`,
          );
        }
        throw new BadRequestException(
          `Invalid ${label} — must be a 10-digit mobile number starting with 6, 7, 8 or 9 (optionally with +91).`,
        );
      }
      continue;
    }
    if (!pattern.test(normalized)) {
      throw new BadRequestException(
        `Invalid ${label} format — expected something like ${example}.`,
      );
    }
  }
}

interface PreviousEmploymentEntry {
  documentUrl?: string;
  [key: string]: unknown;
}

// personalData's plain-string date fields (dateOfBirth, previousEmployment[]
// start/end dates) had no validation at all — the Profile.tsx form's own
// `type="date"` + `max` only constrains the native picker UI; manually
// typed digits still reach this endpoint as a raw string, and an impossible
// or implausible value (e.g. "2026-02-30", a future DOB) was persisted
// as-is, then shown back wherever that date renders (profile, any calendar/
// age display derived from it) exactly as entered. Throws on the first bad
// date found in `patch`, same "only fields actually present" scoping as
// assertValidIdentifiers above.
export function assertValidDates(patch: Record<string, unknown>): void {
  if ('dateOfBirth' in patch) {
    const value = patch.dateOfBirth;
    if (typeof value === 'string' && value.trim() !== '') {
      if (!isValidCalendarDateString(value)) {
        throw new BadRequestException(
          'Invalid date of birth — must be a real calendar date (YYYY-MM-DD).',
        );
      }
      if (value > new Date().toISOString().slice(0, 10)) {
        throw new BadRequestException('Date of birth cannot be in the future.');
      }
    }
  }
  if (Array.isArray(patch.previousEmployment)) {
    for (const entry of patch.previousEmployment as Record<string, unknown>[]) {
      for (const key of ['startDate', 'endDate'] as const) {
        const value = entry?.[key];
        if (
          typeof value === 'string' &&
          value.trim() !== '' &&
          !isValidCalendarDateString(value)
        ) {
          throw new BadRequestException(
            `Invalid previous employment ${key === 'startDate' ? 'start' : 'end'} date — must be a real calendar date (YYYY-MM-DD).`,
          );
        }
      }
      if (
        typeof entry?.startDate === 'string' &&
        typeof entry?.endDate === 'string' &&
        entry.startDate.trim() !== '' &&
        entry.endDate.trim() !== '' &&
        entry.endDate < entry.startDate
      ) {
        throw new BadRequestException(
          'Previous employment end date cannot be before its start date.',
        );
      }
    }
  }
}

// The two file-bearing fields inside the personalData JSON blob
// (cancelledChequeUrl, previousEmployment[].documentUrl) hold durable
// relativeKeys, never signed URLs (see file-token.ts) — signed fresh here
// wherever personalData is exposed, same pattern as EmployeeDocument's
// withSignedFileUrl.
export function signPersonalDataFileUrls(
  personalData: Record<string, unknown>,
  organizationId: string,
): Record<string, unknown> {
  const signed = { ...personalData };
  // A stored "complete" flag can be stale (saved before the required-field list grew, or a field was cleared since):
  // what is shown must reflect the data as it is now.
  if (signed.profileCompleted === true && !isProfileComplete(signed)) {
    signed.profileCompleted = false;
  }
  if (
    typeof signed.cancelledChequeUrl === 'string' &&
    signed.cancelledChequeUrl
  ) {
    // Never sign a key that points outside this organization (client-supplied JSON).
    signed.cancelledChequeUrl = isKeyAllowedForOrg(
      organizationId,
      signed.cancelledChequeUrl,
    )
      ? `/files/${signFileToken(organizationId, signed.cancelledChequeUrl)}`
      : '';
  }
  if (Array.isArray(signed.previousEmployment)) {
    signed.previousEmployment = (
      signed.previousEmployment as PreviousEmploymentEntry[]
    ).map((entry) =>
      entry && typeof entry.documentUrl === 'string' && entry.documentUrl
        ? {
            ...entry,
            documentUrl: isKeyAllowedForOrg(organizationId, entry.documentUrl)
              ? `/files/${signFileToken(organizationId, entry.documentUrl)}`
              : '',
          }
        : entry,
    );
  }
  return signed;
}

// profileCompleted is true only once every field the My Profile form marks as required is filled in (the same list as
// Profile.tsx's REQUIRED_PD_KEYS, kept in step by hand - there is no shared source of truth between them) AND the
// mandatory documents are uploaded. It used to check a 9-field subset, so a profile showed "Complete" while the form
// itself still asked for family, emergency, experience and bank-holder details.
const REQUIRED_FOR_COMPLETION = [
  'fullNameAsPerGovtId',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'bloodGroup',
  'currentAddress',
  'fatherName',
  'fatherContact',
  'motherName',
  'motherContact',
  'emergencyContact1Name',
  'emergencyContact1Number',
  'emergencyContact2Name',
  'emergencyContact2Number',
  'totalExperience',
  'currentOrganization',
  'relevantExperience',
  'bankAccountHolderName',
  'bankName',
  'bankAccountNo',
  'bankIFSC',
] as const;

export function isProfileComplete(
  personalData: Record<string, unknown>,
): boolean {
  return REQUIRED_FOR_COMPLETION.every((field) => {
    const value = personalData[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

// A mandatory DocumentRequirement is satisfied by any uploaded
// EmployeeDocument whose docType matches its name and whose status isn't
// REJECTED — a rejected upload still needs a valid resubmission, so it
// doesn't count. Only active requirements gate completion (a disabled
// requirement stops being expected, matching DocumentRequirement.isActive's
// own "soft-disable" semantics elsewhere).
export function areMandatoryDocumentsUploaded(
  requirements: { name: string; isMandatory: boolean; isActive: boolean }[],
  documents: { docType: string; status: string }[],
): boolean {
  return requirements
    .filter((r) => r.isMandatory && r.isActive)
    .every((r) =>
      documents.some((d) => d.docType === r.name && d.status !== 'REJECTED'),
    );
}

// Merge (not overwrite) semantics — PUT /employees/:id/personal-data sends
// only the fields being changed; anything omitted keeps its prior value.
// previousEmployment/references arrays are replaced wholesale when present
// in the patch (the client always sends the full array back), same as the
// old system's plain object-spread merge.
// mandatoryDocumentsUploaded is the caller's pre-computed
// areMandatoryDocumentsUploaded() result — kept as a plain boolean argument
// (rather than fetched in here) since this function stays DB-free/pure,
// same as before.
// Guards against a signed file link (from signPersonalDataFileUrls, always
// `/files/<token>`) being written back into storage in place of the durable
// relativeKey — e.g. Profile.tsx's save button resubmits its whole loaded
// personalData object (already signed for display) on every save, not just
// the fields the user actually changed, and the client has no way to tell
// these two shapes apart itself. A relativeKey never starts with /files/,
// so a patch value that does is treated as "this field wasn't really
// changed" and the current stored value is kept — otherwise the real
// relativeKey is silently replaced by a token that expires
// (SESSION_ASSET_TTL_SECONDS, see file-token.ts), permanently breaking the
// stored cancelled-cheque / previous-employment document reference.
function dropReSignedFileUrls(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...patch };
  if (
    typeof sanitized.cancelledChequeUrl === 'string' &&
    sanitized.cancelledChequeUrl.startsWith('/files/')
  ) {
    sanitized.cancelledChequeUrl = current.cancelledChequeUrl;
  }
  if (Array.isArray(sanitized.previousEmployment)) {
    sanitized.previousEmployment = sanitized.previousEmployment.map(
      (entry: unknown, i: number) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof (entry as { documentUrl?: unknown }).documentUrl !==
            'string' ||
          !(entry as { documentUrl: string }).documentUrl.startsWith('/files/')
        ) {
          return entry;
        }
        const currentEntry = (
          current.previousEmployment as { documentUrl?: unknown }[] | undefined
        )?.[i];
        return { ...entry, documentUrl: currentEntry?.documentUrl };
      },
    );
  }
  return sanitized;
}

export function mergePersonalData(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  mandatoryDocumentsUploaded: boolean,
): Record<string, unknown> {
  const merged = { ...current, ...dropReSignedFileUrls(current, patch) };
  const completed = isProfileComplete(merged) && mandatoryDocumentsUploaded;
  return {
    ...merged,
    profileCompleted: completed,
    profileCompletedAt: completed
      ? (current.profileCompletedAt ?? new Date().toISOString())
      : null,
  };
}

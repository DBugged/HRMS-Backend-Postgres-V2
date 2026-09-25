import { BadRequestException } from '@nestjs/common';
import { isKeyAllowedForOrg, signFileToken } from '../files/file-token';

// Format checks for the identifier fields inside personalData — these were
// previously free-text with no validation at all (any string, any length,
// any characters), unlike every other structured field in this codebase.
// Each pattern is the standard published format for that document; a blank
// value is always allowed since none of these fields are mandatory.
const IDENTIFIER_PATTERNS: Record<string, { pattern: RegExp; label: string; example: string }> = {
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
  esicNumber: {
    pattern: /^[0-9]{10}$/,
    label: 'ESIC number',
    example: '1234567890',
  },
};

// Throws on the first invalid identifier found in `patch` — called before
// merging a personalData patch onto the stored blob. Only checks fields
// actually present in this patch (a partial edit that doesn't touch PAN
// isn't re-validated against a possibly-already-invalid stored value).
export function assertValidIdentifiers(patch: Record<string, unknown>): void {
  for (const [key, { pattern, label, example }] of Object.entries(IDENTIFIER_PATTERNS)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'string') continue;
    const normalized = key === 'aadharNumber' ? value.replace(/\s+/g, '') : value.trim();
    if (normalized === '') continue;
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

// Ported from the old system's updatePersonalData: profileCompleted flips
// true once these fields are all truthy — an intentionally small subset
// of the full personal-data shape, not "every field filled in". Started as
// 8 fields; maritalStatus added on top, mirroring Profile.tsx's
// REQUIRED_PD_KEYS (the two lists are kept in step by hand, same as
// before this field — no shared source of truth exists between them).
const REQUIRED_FOR_COMPLETION = [
  'fullNameAsPerGovtId',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'currentAddress',
  'fatherName',
  'emergencyContact1Number',
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

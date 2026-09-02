import { signFileToken } from '../files/file-token';

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
    signed.cancelledChequeUrl = `/files/${signFileToken(organizationId, signed.cancelledChequeUrl)}`;
  }
  if (Array.isArray(signed.previousEmployment)) {
    signed.previousEmployment = (
      signed.previousEmployment as PreviousEmploymentEntry[]
    ).map((entry) =>
      entry && typeof entry.documentUrl === 'string' && entry.documentUrl
        ? {
            ...entry,
            documentUrl: `/files/${signFileToken(organizationId, entry.documentUrl)}`,
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
export function mergePersonalData(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  mandatoryDocumentsUploaded: boolean,
): Record<string, unknown> {
  const merged = { ...current, ...patch };
  const completed = isProfileComplete(merged) && mandatoryDocumentsUploaded;
  return {
    ...merged,
    profileCompleted: completed,
    profileCompletedAt: completed
      ? (current.profileCompletedAt ?? new Date().toISOString())
      : null,
  };
}

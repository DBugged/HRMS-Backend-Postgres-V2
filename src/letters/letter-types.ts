// The Document Numbering types this module documents — see organizations/document-numbering.ts for the
// numbering mechanism, and prisma/schema.prisma's Organization.documentNumbering default for the exact
// keys/labels these must match (employeeId/payslip are handled elsewhere already — this module only
// covers the letter types). Kept in sync with letter-template-defaults.ts's keys, but not itself consumed
// anywhere — issueDocumentNumber() accepts any string key and self-heals a missing one via its own
// defaultEntry() fallback, so this list is documentation, not a runtime gate.
export const LETTER_TYPES = [
  'offerLetter',
  'appointmentLetter',
  'relievingLetter',
  'experienceLetter',
  'experienceCertificate',
  'salaryCertificate',
  'fullFinalSettlement',
  'confirmationLetter',
  'probationExtensionLetter',
  'promotionLetter',
  'incrementLetter',
  'transferLetter',
  'resignationAcceptance',
  'terminationLetter',
  'warningLetter',
  'nda',
  'nonCompeteAgreement',
  'nonSolicitationAgreement',
  'letterOfIntent',
  'backgroundVerificationConsent',
  'showCauseNotice',
  'suspensionLetter',
  'retirementLetter',
  'internshipCertificate',
  'employmentVerificationLetter',
] as const;

export type LetterType = (typeof LETTER_TYPES)[number];

export function isLetterType(value: string): value is LetterType {
  return (LETTER_TYPES as readonly string[]).includes(value);
}

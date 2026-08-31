// The 7 previously-dead Document Numbering types (Offer Letter, Appointment
// Letter, Relieving Letter, Experience Letter, Experience Certificate,
// Salary Certificate, Full & Final Settlement) this module wires
// issueDocumentNumber() into — see organizations/document-numbering.ts for
// the numbering mechanism, and prisma/schema.prisma's Organization.
// documentNumbering default for the exact keys/labels these must match
// (employeeId/payslip are handled elsewhere already — this module only
// covers the other 7).
export const LETTER_TYPES = [
  'offerLetter',
  'appointmentLetter',
  'relievingLetter',
  'experienceLetter',
  'experienceCertificate',
  'salaryCertificate',
  'fullFinalSettlement',
] as const;

export type LetterType = (typeof LETTER_TYPES)[number];

export function isLetterType(value: string): value is LetterType {
  return (LETTER_TYPES as readonly string[]).includes(value);
}

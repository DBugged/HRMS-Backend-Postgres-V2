// Purpose: The one rule for the name of an "Employee Document Required" entry (Aadhaar Card, Offer / Appointment Letter).
// Responsibilities: DocumentName() validates it on create and update; documentNameProblem() gives the same verdict as a
//   sentence so a bulk import can skip one bad row with a reason instead of failing the whole file.
// Important: the name is printed on checklists and used as the filing key of uploaded documents, so it is a short
//   label: 1-100 characters, a letter or number in it, no < or >, and only ordinary marks.
import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../common/normalize-input';

export const DOCUMENT_NAME_MAX = 100;
// Letters, numbers, spaces and  _ - . , & ( ) ' # + : /   with at least one letter or number.
const DOCUMENT_NAME = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N} _\-.,&()'’#+:/]+$/u;
const MARKUP = /[<>]/;

export function documentNameProblem(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return 'Document name is required.';
  if (name.length > DOCUMENT_NAME_MAX)
    return `Document name can be at most ${DOCUMENT_NAME_MAX} characters.`;
  if (MARKUP.test(name)) return 'Document name cannot contain < or >.';
  if (!DOCUMENT_NAME.test(name))
    return "Document name must contain a letter or a number, and only letters, numbers, spaces and the marks _ - . , & ( ) ' # + : /";
  return null;
}

export function DocumentName() {
  return applyDecorators(
    Trim(),
    IsString(),
    MinLength(1, { message: 'Document name is required.' }),
    MaxLength(DOCUMENT_NAME_MAX, {
      message: `Document name can be at most ${DOCUMENT_NAME_MAX} characters.`,
    }),
    Matches(/^[^<>]*$/, { message: 'Document name cannot contain < or >.' }),
    Matches(DOCUMENT_NAME, {
      message:
        "Document name must contain a letter or a number, and only letters, numbers, spaces and the marks _ - . , & ( ) ' # + : /",
    }),
  );
}

// A person's name: letters (any script), spaces and the usual . ' - marks, starting with a letter, 2 to 100 characters.
// Rejects markup (`<script>`), digits-only values and other symbols that only ever come from typos or abuse.
export const PERSON_NAME_MAX_LENGTH = 100;
export const PERSON_NAME_MIN_LENGTH = 2;
export const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]+$/u;
export const PERSON_NAME_MESSAGE =
  "must be 2 to 100 characters of letters, spaces and . ' - (no digits or symbols)";

export function isValidPersonName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return (
    v.length >= PERSON_NAME_MIN_LENGTH &&
    v.length <= PERSON_NAME_MAX_LENGTH &&
    PERSON_NAME_PATTERN.test(v)
  );
}

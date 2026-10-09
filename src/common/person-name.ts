// A person's name: letters (any script), spaces and the usual . ' - marks, at least one letter, at most 100 characters.
// Rejects markup (`<script>`), digits-only values and other symbols that only ever come from typos or abuse.
export const PERSON_NAME_MAX_LENGTH = 100;
export const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u;
export const PERSON_NAME_MESSAGE =
  "must contain only letters, spaces and . ' - (no digits or symbols), up to 100 characters";

export function isValidPersonName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return (
    v.length > 0 &&
    v.length <= PERSON_NAME_MAX_LENGTH &&
    PERSON_NAME_PATTERN.test(v)
  );
}

// Purpose: makes a company's employee IDs start with its own letters (e.g. "Demo Company" -> DC-00001) so an ID identifies the company, and
//   employees can sign in with their employee ID as well as their email.
// Responsibilities: pure helpers - the initials of a company name, and a prefix that does not clash with any prefix already in use.
// Important: an ID prefix must be unique across ALL companies for ID sign-in to work, so a clash gets a number added (DC2-) instead of being
//   reused. Existing IDs are never renamed.
const SUFFIX_WORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'corp', 'corporation', 'llc', 'the', 'and', 'of']);

/** Initials of the company's words (at most 4, upper case); a single word gives its first 3 letters. "EMP" when there is nothing usable. */
export function companyInitials(name: string | null | undefined): string {
  const words = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  // "Pvt" / "Ltd" and the like say nothing about which company it is - unless they are all there is.
  const meaningful = words.filter((w) => !SUFFIX_WORDS.has(w.toLowerCase()));
  const used = meaningful.length > 0 ? meaningful : words;
  if (used.length === 0) return 'EMP';
  const letters = used.length === 1 ? used[0].slice(0, 3) : used.map((w) => w[0]).join('').slice(0, 4);
  return letters.toUpperCase() || 'EMP';
}

const clash = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
};

/** `base` followed by '-', or - when that clashes with a taken prefix - `base`+2, +3 ... Taken prefixes are compared as given (e.g. 'DC-'). */
export function uniqueEmployeeIdPrefix(base: string, taken: string[]): string {
  const make = (n: number) => `${base}${n === 1 ? '' : n}-`;
  for (let n = 1; n < 1000; n++) {
    const candidate = make(n);
    if (!taken.some((t) => clash(candidate, t))) return candidate;
  }
  return `${base}${Date.now() % 100000}-`;
}

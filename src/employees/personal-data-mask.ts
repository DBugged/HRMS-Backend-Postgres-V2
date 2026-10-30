// Purpose: Masks sensitive identifiers inside an employee's personalData blob for roles that don't need the full value.
// Responsibilities: maskTail() keeps only the last 4 characters; maskPersonalData() applies it to known sensitive keys.
// Important: Pure and DB-free. Only key names are matched, values are never inspected beyond being strings.
export const SENSITIVE_KEYS = new Set(
  [
    'pan',
    'panNumber',
    'panNo',
    'aadhaar',
    'aadhar',
    'aadhaarNumber',
    'aadharNumber',
    'aadhaarNo',
    'aadharNo',
    'uan',
    'uanNumber',
    'uanNo',
    'bankAccountNo',
    'bankAccountNumber',
    'accountNumber',
    'bankIFSC',
    'ifsc',
    'ifscCode',
    'passport',
    'passportNo',
    'passportNumber',
  ].map((k) => k.toLowerCase()),
);

export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '*'.repeat(value.length);
  return '*'.repeat(value.length - visible) + value.slice(-visible);
}

export function maskPersonalData(
  personalData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...personalData };
  for (const [key, value] of Object.entries(out)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      out[key] = maskTail(value);
    }
  }
  return out;
}

// The identity and bank numbers that every API response shows masked (last 4 only), whoever is asking - the person
// themself and HR/Admin included. The full values come only from GET /employees/:id/personal-data/sensitive (audited),
// when someone presses the eye button.
export const REVEALABLE_KEYS = [
  'panNumber',
  'aadharNumber',
  'uanNumber',
  'bankAccountNo',
] as const;
export type RevealableKey = (typeof REVEALABLE_KEYS)[number];

export function maskRevealable(
  personalData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...personalData };
  for (const key of REVEALABLE_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value !== '') out[key] = maskTail(value);
  }
  return out;
}

// A masked value sent back unchanged (an edit form resends what it was given): it must not overwrite the real number.
export function isMaskedEcho(value: unknown, stored: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.includes('*') &&
    typeof stored === 'string' &&
    stored !== '' &&
    value === maskTail(stored)
  );
}

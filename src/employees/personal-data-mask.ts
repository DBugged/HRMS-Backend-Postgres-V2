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

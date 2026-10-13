// Purpose: the employee's personal e-mail address (personalData.personalEmail), validated.
// Responsibilities: one reading of it for everything that must reach someone after their company mailbox is closed
//   - the final settlement documents, Form 130 / Form 16, the exit confirmation - and the offboarding guard that
//   refuses to start an exit without one.
// Important: the company e-mail is locked once the exit completes, so this is the only address that still works.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function personalEmailOf(personalData: unknown): string | null {
  const raw = (personalData as { personalEmail?: unknown } | null | undefined)
    ?.personalEmail;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return EMAIL_RE.test(value) ? value : null;
}

export const PERSONAL_EMAIL_REQUIRED_MESSAGE =
  'This employee has no personal email on file. Add it to their profile (Personal Email) first - it is where their final payslip, settlement statement and tax certificate are sent once the company mailbox is closed.';

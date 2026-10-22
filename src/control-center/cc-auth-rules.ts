// Purpose: The sign-in rules for Control Panel Super Admins that need no database: lock-out after repeated wrong
//   passwords, token creation and hashing, and the password rule.
// Important: pure (the clock is passed in). Tokens are random and only their SHA-256 is stored, so a copy of the database
//   cannot be used to sign in or to reset a password.
import { createHash, randomBytes } from 'crypto';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const ACCESS_TOKEN_SECONDS = 900;
export const REFRESH_TOKEN_DAYS = 7;
export const RESET_TOKEN_MINUTES = 30;
export const MIN_PASSWORD_LENGTH = 12;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** A random token to hand out, and the hash to keep. */
export function newToken(bytes = 48): { token: string; hash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Minutes left on a lock, or 0 when the account is not locked. */
export function lockMinutesLeft(lockedUntil: Date | null | undefined, now: Date): number {
  if (!lockedUntil || lockedUntil <= now) return 0;
  return Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000);
}

/** What to store after a wrong password: the new count, and a lock when the limit is reached (the count then resets). */
export function afterFailedAttempt(
  attempts: number,
  now: Date,
): { failedLoginAttempts: number; lockedUntil: Date | null } {
  const next = attempts + 1;
  if (next >= MAX_FAILED_ATTEMPTS) {
    return { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60000) };
  }
  return { failedLoginAttempts: next, lockedUntil: null };
}

/** A message when the password is too weak, else ''. */
export function passwordProblem(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Use upper and lower case letters and a number.';
  }
  return '';
}

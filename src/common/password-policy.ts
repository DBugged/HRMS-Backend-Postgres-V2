import * as crypto from 'crypto';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Single source of truth for password rules. Applied only when a password is
// SET or CHANGED — never at login, so existing weak passwords keep working.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'password',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwertyuiop',
  'abc123',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'changeme',
]);

/**
 * Returns human-readable problems (empty array = acceptable).
 * `context` optionally carries the user's email/name to reject trivial reuse.
 */
export function validatePasswordPolicy(
  password: unknown,
  context: { email?: string; name?: string } = {},
): string[] {
  if (typeof password !== 'string') return ['password must be a string'];
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9\s]/.test(password)) problems.push('a symbol');
  if (/\s/.test(password)) problems.push('no whitespace');

  const lower = password.toLowerCase();
  // Strip trailing digits/symbols so "Password1!" is caught as "password".
  const base = lower.replace(/[^a-z]+$/, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(base))
    problems.push('not be a very common password');

  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local))
    problems.push('not contain your email name');
  const name = context.name?.trim().toLowerCase();
  if (name && name.length >= 4 && !/\s/.test(name) && lower.includes(name))
    problems.push('not contain your name');
  return problems;
}

export function passwordPolicyMessage(problems: string[]): string {
  return `Password must have: ${problems.join('; ')}.`;
}

/** class-validator decorator; reads email/name off the DTO when present. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const o = args.object as { email?: string; name?: string };
          return validatePasswordPolicy(value, o).length === 0;
        },
        defaultMessage(args: ValidationArguments) {
          const o = args.object as { email?: string; name?: string };
          return passwordPolicyMessage(validatePasswordPolicy(args.value, o));
        },
      },
    });
  };
}

/** Random password guaranteed to satisfy the policy (crypto.randomInt). */
export function generatePolicyPassword(length = 14): string {
  const sets = [
    'abcdefghijkmnopqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    '23456789',
    '!@#$%^&*-_=+?',
  ];
  const all = sets.join('');
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

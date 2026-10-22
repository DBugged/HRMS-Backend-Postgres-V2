import { permissionsFor, roleHas } from './cc-permissions';
import {
  MAX_FAILED_ATTEMPTS,
  afterFailedAttempt,
  hashToken,
  lockMinutesLeft,
  newToken,
  normalizeEmail,
  passwordProblem,
} from './cc-auth-rules';

describe('Control Center roles', () => {
  it('gives OWNER everything and READ_ONLY only reads', () => {
    expect(roleHas('OWNER', 'billing:write')).toBe(true);
    expect(roleHas('READ_ONLY', 'organizations:read')).toBe(true);
    expect(roleHas('READ_ONLY', 'organizations:write')).toBe(false);
    expect(roleHas('READ_ONLY', 'super-admins:read')).toBe(false);
  });
  it('reads a <resource>:* wildcard like the panel does', () => {
    expect(roleHas('BILLING', 'subscriptions:write')).toBe(true);
    expect(roleHas('BILLING', 'tickets:read')).toBe(false);
    expect(roleHas('SUPPORT', 'impersonation:create')).toBe(true);
    expect(roleHas('SUPPORT', 'billing:read')).toBe(false);
  });
  it('lists the permissions a role holds', () => {
    expect(permissionsFor('OWNER')).toEqual(['*']);
    expect(permissionsFor('ADMIN')).toContain('organizations:*');
  });
});

describe('sign-in rules', () => {
  const now = new Date('2026-11-27T10:00:00Z');
  it('counts wrong passwords and locks at the limit', () => {
    expect(afterFailedAttempt(0, now)).toEqual({ failedLoginAttempts: 1, lockedUntil: null });
    const locked = afterFailedAttempt(MAX_FAILED_ATTEMPTS - 1, now);
    expect(locked.failedLoginAttempts).toBe(0);
    expect(locked.lockedUntil?.toISOString()).toBe('2026-11-27T10:15:00.000Z');
  });
  it('says how long a lock still has to run', () => {
    expect(lockMinutesLeft(new Date('2026-11-27T10:07:30Z'), now)).toBe(8);
    expect(lockMinutesLeft(new Date('2026-11-27T09:59:00Z'), now)).toBe(0);
    expect(lockMinutesLeft(null, now)).toBe(0);
  });
  it('stores only the hash of a token, and the same token always hashes the same', () => {
    const { token, hash } = newToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(newToken().token).not.toBe(token);
  });
  it('lower-cases the email and checks the password strength', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
    expect(passwordProblem('short')).not.toBe('');
    expect(passwordProblem('alllowercase123')).not.toBe('');
    expect(passwordProblem('Correct-Horse-9')).toBe('');
  });
});

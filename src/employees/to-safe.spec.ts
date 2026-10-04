// Purpose: Guards that toSafe() strips account-security/payroll-internal fields when masking for non-HR viewers.
import { toSafe } from './to-safe';

const user = {
  id: 'u1',
  organizationId: 'o1',
  name: 'A',
  password: 'hash',
  resetPasswordToken: 't',
  resetPasswordExpires: null,
  profileImage: null,
  personalData: {},
  lastLoginAt: new Date(),
  failedLoginAttempts: 2,
  lockedUntil: null,
  mustChangePassword: true,
  emailVerified: true,
  excludeFromPayroll: true,
  lwfExempt: true,
  notificationPreferences: {},
} as never;

describe('toSafe masking', () => {
  it('removes internal fields when masked', () => {
    const out = toSafe(user, true) as Record<string, unknown>;
    for (const k of [
      'lastLoginAt',
      'failedLoginAttempts',
      'lockedUntil',
      'mustChangePassword',
      'emailVerified',
      'excludeFromPayroll',
      'lwfExempt',
      'notificationPreferences',
      'password',
    ]) {
      expect(out).not.toHaveProperty(k);
    }
    expect(out.name).toBe('A');
  });
  it('keeps them when not masked (HR/Admin/self)', () => {
    const out = toSafe(user) as Record<string, unknown>;
    expect(out.lwfExempt).toBe(true);
    expect(out).not.toHaveProperty('password');
  });
});

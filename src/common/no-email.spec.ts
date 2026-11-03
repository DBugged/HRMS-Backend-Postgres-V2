import { isPlaceholderEmail, loginRefusal, placeholderEmailFor, readLoginPolicy } from './no-email';

describe('no-email helpers', () => {
  it('makes an undeliverable placeholder from the employee id', () => {
    expect(placeholderEmailFor('DP-00123')).toBe('dp-00123@noemail.invalid');
    expect(isPlaceholderEmail('dp-00123@noemail.invalid')).toBe(true);
    expect(isPlaceholderEmail('jane@acme.test')).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
  });
  it('reads the company choices with safe defaults', () => {
    expect(readLoginPolicy({})).toEqual({ method: 'EMAIL_OR_ID', allowNoEmail: false });
    expect(readLoginPolicy({ loginMethod: 'ID_ONLY', allowNoEmail: true })).toEqual({ method: 'ID_ONLY', allowNoEmail: true });
    expect(readLoginPolicy({ loginMethod: 'bogus' }).method).toBe('EMAIL_OR_ID');
  });
  it('refuses the way of signing in the company switched off', () => {
    expect(loginRefusal({ method: 'EMAIL', allowNoEmail: false }, false, true)).toMatch(/email/);
    expect(loginRefusal({ method: 'ID_ONLY', allowNoEmail: false }, true, true)).toMatch(/employee ID/);
    expect(loginRefusal({ method: 'ID_ONLY', allowNoEmail: false }, false, true)).toBeNull();
    expect(loginRefusal({ method: 'EMAIL_OR_ID', allowNoEmail: false }, true, true)).toBeNull();
    expect(loginRefusal({ method: 'EMAIL', allowNoEmail: true }, false, false)).toMatch(/email/);
  });
});

import {
  generatePolicyPassword,
  validatePasswordPolicy,
} from './password-policy';

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(validatePasswordPolicy('TestPass123!')).toEqual([]);
  });
  it('lists what is missing', () => {
    const p = validatePasswordPolicy('abc');
    expect(p).toEqual(
      expect.arrayContaining([
        expect.stringContaining('10 characters'),
        'an uppercase letter',
        'a digit',
        'a symbol',
      ]),
    );
  });
  it('rejects whitespace, too long, and common passwords', () => {
    expect(validatePasswordPolicy('Valid Pass123!')).toContain('no whitespace');
    expect(validatePasswordPolicy('Aa1!' + 'x'.repeat(130))).toEqual([
      'at most 128 characters',
    ]);
    expect(validatePasswordPolicy('Password1!')).toContain(
      'not be a very common password',
    );
  });
  it('rejects passwords containing the email local part', () => {
    expect(
      validatePasswordPolicy('Johnsmith12!', { email: 'johnsmith@x.com' }),
    ).toContain('not contain your email name');
  });
  it('generated passwords always satisfy the policy', () => {
    for (let i = 0; i < 200; i++)
      expect(validatePasswordPolicy(generatePolicyPassword())).toEqual([]);
  });
});

import {
  inviteCodeValid,
  registrationAllowed,
  registrationOpen,
} from './registration-policy';

describe('registration policy', () => {
  it('is open unless switched off', () => {
    expect(registrationOpen({})).toBe(true);
    expect(registrationOpen({ REGISTRATION_ENABLED: 'true' })).toBe(true);
    expect(registrationOpen({ REGISTRATION_ENABLED: 'false' })).toBe(false);
  });

  it('when invitation-only, needs one of the configured codes', () => {
    const env = {
      REGISTRATION_ENABLED: 'false',
      REGISTRATION_INVITE_CODES: 'ALPHA-1, beta-2',
    };
    expect(registrationAllowed(undefined, env)).toBe(false);
    expect(registrationAllowed('wrong', env)).toBe(false);
    expect(registrationAllowed('ALPHA-1', env)).toBe(true);
    expect(registrationAllowed(' beta-2 ', env)).toBe(true);
  });

  it('refuses everything when invitation-only and no codes are configured', () => {
    const env = { REGISTRATION_ENABLED: 'false' };
    expect(inviteCodeValid('anything', env)).toBe(false);
    expect(registrationAllowed('anything', env)).toBe(false);
  });

  it('an open registration ignores the code', () => {
    expect(registrationAllowed(undefined, {})).toBe(true);
  });
});

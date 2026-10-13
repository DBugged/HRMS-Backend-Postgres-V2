import { personalEmailOf } from './personal-email';

describe('personalEmailOf', () => {
  it('returns a valid personal email, trimmed', () => {
    expect(personalEmailOf({ personalEmail: ' asha@gmail.com ' })).toBe(
      'asha@gmail.com',
    );
  });

  it('is null when missing, blank or not an email', () => {
    expect(personalEmailOf(null)).toBeNull();
    expect(personalEmailOf({})).toBeNull();
    expect(personalEmailOf({ personalEmail: '   ' })).toBeNull();
    expect(personalEmailOf({ personalEmail: 'not-an-email' })).toBeNull();
    expect(personalEmailOf({ personalEmail: 42 })).toBeNull();
  });
});

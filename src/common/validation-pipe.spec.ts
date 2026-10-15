import { friendlyMessage, fieldLabel } from './validation-pipe';

describe('validation messages', () => {
  it('labels a property as words', () => {
    expect(fieldLabel('noticePeriodDays')).toBe('Notice period days');
  });

  it('rewrites the stock class-validator sentences', () => {
    expect(
      friendlyMessage(
        'noticePeriodDays',
        'noticePeriodDays must not be greater than 365',
      ),
    ).toBe('Notice period days must be at most 365.');
    expect(
      friendlyMessage('noticePeriodDays', 'noticePeriodDays must not be less than 0'),
    ).toBe('Notice period days must be at least 0.');
    expect(
      friendlyMessage(
        'noticePeriodDays',
        'noticePeriodDays must be an integer number',
      ),
    ).toBe('Notice period days must be a whole number.');
    expect(friendlyMessage('reason', 'reason should not be empty')).toBe(
      'Reason is required.',
    );
    expect(friendlyMessage('email', 'email must be an email')).toBe(
      'Email must be a valid email address.',
    );
  });

  it('keeps a message the code wrote itself', () => {
    expect(
      friendlyMessage('requestedLwd', 'Pick a date within the next year.'),
    ).toBe('Pick a date within the next year.');
  });

  it('words an unexpected field plainly', () => {
    expect(
      friendlyMessage('hack', 'property hack should not exist'),
    ).toBe('"hack" is not an accepted field.');
  });
});

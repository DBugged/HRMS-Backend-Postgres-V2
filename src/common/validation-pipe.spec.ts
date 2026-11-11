import { friendlyMessage, fieldLabel, pickConstraint } from './validation-pipe';

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

describe('pickConstraint', () => {
  it('reports a missing value before a length or range rule', () => {
    expect(
      pickConstraint({ maxLength: 'password must be shorter than or equal to 128 characters', isString: 'password must be a string', isNotEmpty: 'password should not be empty' }),
    ).toBe('password should not be empty');
  });
  it('reports the wrong type before a range rule', () => {
    expect(pickConstraint({ max: 'amount must not be greater than 10', isNumber: 'amount must be a number conforming to the specified constraints' })).toContain('must be a number');
  });
  it('falls back to the first rule when none is a basic one', () => {
    expect(pickConstraint({ matches: 'custom message', minLength: 'x' })).toBe('custom message');
  });
  it('words the decimal-places rule for people', () => {
    expect(friendlyMessage('amount', 'amount must be a number conforming to the specified constraints')).toBe('Amount must be a number with an allowed number of decimal places.');
  });
});

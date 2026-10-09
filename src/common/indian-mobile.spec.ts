import { isValidIndianMobile } from './indian-mobile';

describe('isValidIndianMobile', () => {
  it.each([
    '9876543210',
    '6000000000',
    '+91 98765 43210',
    '+91-9876543210',
    '+919876543210',
  ])('accepts %s', (v) => expect(isValidIndianMobile(v)).toBe(true));

  it.each([
    '0987654321',
    '099999 99999',
    '+91 099999 99999',
    '5876543210',
    '987654321',
    '98765432101',
    '+44 7911 123456',
    '98765abc10',
    '',
  ])('rejects %s', (v) => expect(isValidIndianMobile(v)).toBe(false));

  it('rejects non-strings', () =>
    expect(isValidIndianMobile(9876543210)).toBe(false));
});

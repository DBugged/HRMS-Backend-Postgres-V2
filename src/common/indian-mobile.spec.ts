import { formatIndianMobile, isValidIndianMobile } from './indian-mobile';

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

describe('formatIndianMobile', () => {
  it('stores a valid number with the country code', () => {
    expect(formatIndianMobile('9876543210')).toBe('+91 98765 43210');
    expect(formatIndianMobile('+91-9876543210')).toBe('+91 98765 43210');
    expect(formatIndianMobile('+91 98765 43210')).toBe('+91 98765 43210');
  });
  it('leaves blank and invalid values unchanged', () => {
    expect(formatIndianMobile('')).toBe('');
    expect(formatIndianMobile('12345')).toBe('12345');
    expect(formatIndianMobile(undefined)).toBeUndefined();
  });
});

import { validateSectionData } from './org-settings-validation';

describe('India-only organization settings', () => {
  it('accepts India, IST, INR and +91 numbers', () => {
    expect(() =>
      validateSectionData({
        country: 'India',
        phone: '+91 98765 43210',
        mobile: '9876543210',
      }),
    ).not.toThrow();
    expect(() =>
      validateSectionData({
        policies: { timezone: 'Asia/Kolkata', currency: 'INR' },
      }),
    ).not.toThrow();
  });

  it('rejects any other country', () => {
    expect(() => validateSectionData({ country: 'United States' })).toThrow(
      /only India is supported/,
    );
    expect(() => validateSectionData({ country: '' })).toThrow(
      /only India is supported/,
    );
  });

  it('rejects another time zone or currency', () => {
    expect(() =>
      validateSectionData({ policies: { timezone: 'Europe/London' } }),
    ).toThrow(/only India is supported/);
    expect(() =>
      validateSectionData({ policies: { currency: 'USD' } }),
    ).toThrow(/only India is supported/);
  });

  it('rejects a phone number with another country code', () => {
    expect(() => validateSectionData({ phone: '+44 20 7946 0958' })).toThrow(
      /Indian number/,
    );
    expect(() => validateSectionData({ mobile: '+1 415 555 2671' })).toThrow(
      /Indian number/,
    );
    expect(() => validateSectionData({ phone: '+919876543210' })).not.toThrow();
  });

  it('rejects an Indian number that starts with 0 or is not a 10-digit mobile', () => {
    expect(() => validateSectionData({ phone: '+91 099999 99999' })).toThrow(
      /mobile number/,
    );
    expect(() => validateSectionData({ phone: '+911234567890' })).toThrow(
      /mobile number/,
    );
    expect(() => validateSectionData({ mobile: '98765' })).toThrow(
      /mobile number/,
    );
  });

  it('accepts Maharashtra or a blank state, rejects any other state', () => {
    expect(() => validateSectionData({ state: 'Maharashtra' })).not.toThrow();
    expect(() => validateSectionData({ state: '' })).not.toThrow();
    expect(() => validateSectionData({ state: 'Karnataka' })).toThrow(
      /configured for Maharashtra only/,
    );
  });
});

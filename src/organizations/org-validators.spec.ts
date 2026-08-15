import { validateOrgFields, validateIfsc } from './org-validators';

describe('validateOrgFields', () => {
  it('passes when all recognized fields are absent or empty', () => {
    expect(validateOrgFields({})).toBeNull();
    expect(validateOrgFields({ gstin: '', contactEmail: '  ' })).toBeNull();
  });

  it('passes valid GSTIN/PAN/TAN/CIN/email/website/phone/pincode', () => {
    expect(
      validateOrgFields({
        gstin: '29ABCDE1234F1Z5',
        pan: 'ABCDE1234F',
        tan: 'ABCD12345E',
        cin: 'L12345AB2020PLC123456',
        contactEmail: 'hr@acme.test',
        website: 'https://acme.test',
        phone: '+91 98765 43210',
        pincode: '560001',
      }),
    ).toBeNull();
  });

  it('rejects a malformed GSTIN', () => {
    expect(validateOrgFields({ gstin: 'not-a-gstin' })).toMatch(/gstin/);
  });

  it('rejects a malformed email', () => {
    expect(validateOrgFields({ contactEmail: 'not-an-email' })).toMatch(
      /contactEmail/,
    );
  });

  it('rejects a malformed pincode', () => {
    expect(validateOrgFields({ pincode: '123' })).toMatch(/pincode/);
  });
});

describe('validateIfsc', () => {
  it('accepts empty/absent values', () => {
    expect(validateIfsc(undefined)).toBe(true);
    expect(validateIfsc('')).toBe(true);
  });

  it('accepts a valid IFSC', () => {
    expect(validateIfsc('HDFC0001234')).toBe(true);
  });

  it('rejects a malformed IFSC', () => {
    expect(validateIfsc('not-ifsc')).toBe(false);
  });
});

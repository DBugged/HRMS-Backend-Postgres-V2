import { normalizeOrgFields, validateOrgFields } from './org-validators';

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

describe('normalizeOrgFields', () => {
  it('trims and upper-cases identifier fields so a pasted space no longer fails', () => {
    const data = normalizeOrgFields({
      gstin: ' 27abcde1234f1z5 ',
      pan: 'ABCDE 1234F',
    });
    expect(data.gstin).toBe('27ABCDE1234F1Z5');
    expect(data.pan).toBe('ABCDE1234F');
    expect(validateOrgFields(data)).toBeNull();
  });

  it('only trims (keeps inner spaces and case) for free-form registration numbers', () => {
    const data = normalizeOrgFields({ registrationNumber: '  Reg No 12/2020 ' });
    expect(data.registrationNumber).toBe('Reg No 12/2020');
  });

  it('leaves absent and non-string fields alone', () => {
    const data = normalizeOrgFields({ gstin: null, city: 'Pune' });
    expect(data).toEqual({ gstin: null, city: 'Pune' });
  });
});

describe('validateOrgFields GSTIN and PAN', () => {
  it('refuses a GSTIN whose embedded PAN differs from the PAN', () => {
    expect(
      validateOrgFields({ gstin: '29AAACH7409R1ZX', pan: 'NNHIJ7890P' }),
    ).toMatch(/does not match the PAN/);
  });

  it('accepts a GSTIN that contains the PAN', () => {
    expect(
      validateOrgFields({ gstin: '29AAACH7409R1ZX', pan: 'AAACH7409R' }),
    ).toBeNull();
  });
});

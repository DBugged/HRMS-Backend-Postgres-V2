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

describe('document numbering {EMPID}', () => {
  const numbering = (type: string, format: string) => ({
    documentNumbering: {
      [type]: { label: 'X', format, resetRule: 'never', counter: 0 },
    },
  });

  it('accepts {EMPID} in a letter or payslip format', () => {
    expect(() =>
      validateSectionData(numbering('payslip', 'PS-{EMPID}-{YYYYMM}-{00001}')),
    ).not.toThrow();
  });

  it("refuses {EMPID} and {EMPNAME} in the employee ID's own format", () => {
    expect(() =>
      validateSectionData(numbering('employeeId', '{EMPID}-{00001}')),
    ).toThrow(/cannot contain \{EMPID\} or \{EMPNAME\}/);
    expect(() =>
      validateSectionData(numbering('employeeId', 'E-{EMPNAME}-{00001}')),
    ).toThrow(/cannot contain/);
  });

  it('accepts {EMPNAME} after the counter in a payslip format', () => {
    expect(() =>
      validateSectionData(
        numbering('payslip', 'PS-{YYYYMM}-{00001}-{EMPID}-{EMPNAME}'),
      ),
    ).not.toThrow();
  });

  it('allows no running number when the format carries the Employee ID', () => {
    expect(() =>
      validateSectionData(numbering('payslip', 'PS-{YYYYMM}-{EMPID}')),
    ).not.toThrow();
  });

  it('refuses no running number without the Employee ID, and for the Employee ID itself', () => {
    expect(() =>
      validateSectionData(numbering('payslip', 'PS-{YYYYMM}')),
    ).toThrow(/needs a counter/);
    expect(() =>
      validateSectionData(numbering('employeeId', 'DEMO')),
    ).toThrow(/must contain a counter/);
  });

  it('refuses two counters', () => {
    expect(() =>
      validateSectionData(numbering('payslip', 'PS-{0001}-{0002}')),
    ).toThrow(/only one counter/);
  });
});

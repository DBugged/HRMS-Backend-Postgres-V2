import {
  areMandatoryDocumentsUploaded,
  assertValidAddress,
  assertValidDates,
  latestAllowedDateOfBirth,
  assertValidIdentifiers,
  isProfileComplete,
  signPersonalDataFileUrls,
  mergePersonalData,
} from './personal-data';

const COMPLETE_FIELDS = {
  fullNameAsPerGovtId: 'Jane Doe',
  dateOfBirth: '1990-01-01',
  gender: 'Female',
  maritalStatus: 'Single',
  bloodGroup: 'O+',
  currentAddress: '123 Main St',
  fatherName: 'John Doe',
  fatherContact: '9876543210',
  motherName: 'Jane Roe',
  motherContact: '9876543211',
  emergencyContact1Name: 'Sam Doe',
  emergencyContact1Number: '+91 98765 43210',
  emergencyContact2Name: 'Amy Doe',
  emergencyContact2Number: '9876543212',
  totalExperience: '5',
  currentOrganization: 'Acme',
  relevantExperience: 'Payroll',
  bankAccountHolderName: 'Jane Doe',
  bankName: 'HDFC',
  bankAccountNo: '123456789',
  bankIFSC: 'HDFC0001234',
};

describe('isProfileComplete', () => {
  it('is false for an empty object', () => {
    expect(isProfileComplete({})).toBe(false);
  });

  it('is false when one required field is missing', () => {
    const { fatherName, ...rest } = COMPLETE_FIELDS;
    void fatherName;
    expect(isProfileComplete(rest)).toBe(false);
  });

  it('is false when a required field is an empty/whitespace string', () => {
    expect(isProfileComplete({ ...COMPLETE_FIELDS, fatherName: '  ' })).toBe(
      false,
    );
  });

  it('is true once every required field is present', () => {
    expect(isProfileComplete(COMPLETE_FIELDS)).toBe(true);
  });

  it('is false when a family, experience or bank-holder field is missing', () => {
    for (const key of [
      'bloodGroup',
      'motherContact',
      'emergencyContact2Name',
      'totalExperience',
      'bankAccountHolderName',
    ]) {
      expect(isProfileComplete({ ...COMPLETE_FIELDS, [key]: '' })).toBe(false);
    }
  });

  it('ignores fields outside the required set', () => {
    expect(
      isProfileComplete({ ...COMPLETE_FIELDS, personalEmail: undefined }),
    ).toBe(true);
  });
});

describe('areMandatoryDocumentsUploaded', () => {
  const MANDATORY = {
    name: 'Bank Passbook',
    isMandatory: true,
    isActive: true,
  };

  it('is true when there are no mandatory requirements', () => {
    expect(areMandatoryDocumentsUploaded([], [])).toBe(true);
  });

  it('is false when a mandatory requirement has no matching document', () => {
    expect(areMandatoryDocumentsUploaded([MANDATORY], [])).toBe(false);
  });

  it('is true once a matching, non-rejected document exists', () => {
    expect(
      areMandatoryDocumentsUploaded(
        [MANDATORY],
        [{ docType: 'Bank Passbook', status: 'PENDING' }],
      ),
    ).toBe(true);
  });

  it('is false when the matching document was rejected', () => {
    expect(
      areMandatoryDocumentsUploaded(
        [MANDATORY],
        [{ docType: 'Bank Passbook', status: 'REJECTED' }],
      ),
    ).toBe(false);
  });

  it('ignores optional and inactive requirements', () => {
    expect(
      areMandatoryDocumentsUploaded(
        [
          { name: 'Optional Doc', isMandatory: false, isActive: true },
          { name: 'Disabled Doc', isMandatory: true, isActive: false },
        ],
        [],
      ),
    ).toBe(true);
  });
});

describe('mergePersonalData', () => {
  it('merges the patch onto the current data without dropping other fields', () => {
    const current = { personalEmail: 'jane@personal.test', bloodGroup: 'O+' };
    const merged = mergePersonalData(current, { bloodGroup: 'A+' }, true);
    expect(merged.personalEmail).toBe('jane@personal.test');
    expect(merged.bloodGroup).toBe('A+');
  });

  it('sets profileCompleted true and stamps profileCompletedAt the first time all required fields are present and mandatory documents are uploaded', () => {
    const merged = mergePersonalData({}, COMPLETE_FIELDS, true);
    expect(merged.profileCompleted).toBe(true);
    expect(typeof merged.profileCompletedAt).toBe('string');
  });

  it('stays incomplete when required fields are present but mandatory documents are not uploaded', () => {
    const merged = mergePersonalData({}, COMPLETE_FIELDS, false);
    expect(merged.profileCompleted).toBe(false);
    expect(merged.profileCompletedAt).toBeNull();
  });

  it('keeps the original profileCompletedAt on a later merge, does not re-stamp it', () => {
    const first = mergePersonalData({}, COMPLETE_FIELDS, true);
    const second = mergePersonalData(first, { bloodGroup: 'B+' }, true);
    expect(second.profileCompletedAt).toBe(first.profileCompletedAt);
  });

  it('clears profileCompletedAt if a later merge removes a required field', () => {
    const first = mergePersonalData({}, COMPLETE_FIELDS, true);
    const second = mergePersonalData(first, { fatherName: '' }, true);
    expect(second.profileCompleted).toBe(false);
    expect(second.profileCompletedAt).toBeNull();
  });

  // The client (Profile.tsx) resubmits its whole loaded personalData object
  // on every save, which was already signed for display — a patch carrying
  // a signed /files/<token> link for a file field must not overwrite the
  // durable relativeKey stored for it, or that reference breaks once the
  // token expires.
  it('keeps the stored cancelledChequeUrl relativeKey when the patch carries a signed link instead', () => {
    const current = { cancelledChequeUrl: 'documents/org1/cheque.pdf' };
    const merged = mergePersonalData(
      current,
      { cancelledChequeUrl: '/files/abc123signedtoken' },
      true,
    );
    expect(merged.cancelledChequeUrl).toBe('documents/org1/cheque.pdf');
  });

  it('still applies a real relativeKey for cancelledChequeUrl (a genuine new upload)', () => {
    const current = { cancelledChequeUrl: 'documents/org1/old.pdf' };
    const merged = mergePersonalData(
      current,
      { cancelledChequeUrl: 'documents/org1/new.pdf' },
      true,
    );
    expect(merged.cancelledChequeUrl).toBe('documents/org1/new.pdf');
  });

  it('keeps the stored previousEmployment documentUrl relativeKey when the patch carries a signed link', () => {
    const current = {
      previousEmployment: [
        { companyName: 'Acme', documentUrl: 'documents/org1/acme.pdf' },
      ],
    };
    const merged = mergePersonalData(
      current,
      {
        previousEmployment: [
          { companyName: 'Acme', documentUrl: '/files/xyz789signedtoken' },
        ],
      },
      true,
    );
    expect((merged.previousEmployment as any[])[0].documentUrl).toBe(
      'documents/org1/acme.pdf',
    );
  });
});

describe('India-only phone numbers in personal data', () => {
  it('accepts +91 and plain numbers, rejects another country code', () => {
    expect(() =>
      assertValidIdentifiers({ fatherContact: '+91 98765 43210' }),
    ).not.toThrow();
    expect(() =>
      assertValidIdentifiers({ fatherContact: '9876543210' }),
    ).not.toThrow();
    expect(() =>
      assertValidIdentifiers({ emergencyContact1Number: '+44 20 7946 0958' }),
    ).toThrow(/Indian \(\+91\)/);
  });

  it('rejects a plain number that starts with 0 or is not a mobile number', () => {
    expect(() =>
      assertValidIdentifiers({ motherContact: '0123456789' }),
    ).toThrow(/Mother's contact number/);
    expect(() =>
      assertValidIdentifiers({ emergencyContact2Number: '5123456789' }),
    ).toThrow(/Emergency contact 2 number/);
    expect(() =>
      assertValidIdentifiers({ motherContact: '6123456789' }),
    ).not.toThrow();
  });
});

describe('assertValidDates', () => {
  it('accepts a real, past date of birth', () => {
    expect(() => assertValidDates({ dateOfBirth: '1990-01-01' })).not.toThrow();
  });

  it('rejects a calendar-impossible date of birth (Feb 30)', () => {
    expect(() => assertValidDates({ dateOfBirth: '2026-02-30' })).toThrow(
      /real calendar date/,
    );
  });

  it('rejects a date of birth in the future', () => {
    expect(() => assertValidDates({ dateOfBirth: '2099-01-01' })).toThrow(
      /cannot be in the future/,
    );
  });

  it('ignores a blank or absent date of birth', () => {
    expect(() => assertValidDates({ dateOfBirth: '' })).not.toThrow();
    expect(() => assertValidDates({})).not.toThrow();
  });

  it('rejects an impossible previousEmployment start/end date', () => {
    expect(() =>
      assertValidDates({
        previousEmployment: [
          { startDate: '2020-13-01', endDate: '2021-01-01' },
        ],
      }),
    ).toThrow(/start date/);
  });

  it('rejects a previousEmployment end date before its start date', () => {
    expect(() =>
      assertValidDates({
        previousEmployment: [
          { startDate: '2021-01-01', endDate: '2020-01-01' },
        ],
      }),
    ).toThrow(/end date cannot be before/);
  });

  it('accepts a valid previousEmployment date range', () => {
    expect(() =>
      assertValidDates({
        previousEmployment: [
          { startDate: '2018-01-01', endDate: '2020-01-01' },
        ],
      }),
    ).not.toThrow();
  });
});

describe('assertValidAddress', () => {
  it('accepts a normal address and an empty one', () => {
    expect(() =>
      assertValidAddress({ currentAddress: '12 Main Road, Surat, Gujarat' }),
    ).not.toThrow();
    expect(() => assertValidAddress({ currentAddress: '   ' })).not.toThrow();
    expect(() => assertValidAddress({ name: 'x' })).not.toThrow();
  });

  it('rejects an address that is too short or longer than 250 characters', () => {
    expect(() => assertValidAddress({ currentAddress: 'Surat' })).toThrow(
      /too short/,
    );
    expect(() =>
      assertValidAddress({ currentAddress: 'a'.repeat(251) }),
    ).toThrow(/at most 250/);
    expect(() =>
      assertValidAddress({ currentAddress: 'a'.repeat(250) }),
    ).not.toThrow();
  });
});

describe('assertValidIdentifiers: PF number', () => {
  it('accepts the EPFO member account with or without slashes', () => {
    expect(() =>
      assertValidIdentifiers({ pfNumber: 'MH/BAN/1234567/000/0001234' }),
    ).not.toThrow();
    expect(() =>
      assertValidIdentifiers({ pfNumber: 'MHBAN12345670000001234' }),
    ).not.toThrow();
  });

  it('rejects anything else', () => {
    expect(() => assertValidIdentifiers({ pfNumber: 'abc' })).toThrow(
      /Invalid PF number/,
    );
    expect(() =>
      assertValidIdentifiers({ pfNumber: 'MH/BAN/123/000/0001234' }),
    ).toThrow(/Invalid PF number/);
    expect(() => assertValidIdentifiers({ pfNumber: '' })).not.toThrow();
  });
});

describe('signPersonalDataFileUrls refreshes a stale completed flag', () => {
  it('reports not complete when the stored flag is true but a required field is empty', () => {
    const out = signPersonalDataFileUrls(
      { ...COMPLETE_FIELDS, bloodGroup: '', profileCompleted: true },
      'org-1',
    );
    expect(out.profileCompleted).toBe(false);
  });
});

describe('minimum age of 18', () => {
  it('computes the latest allowed date of birth, including 29 Feb', () => {
    expect(latestAllowedDateOfBirth(new Date('2026-10-11T10:00:00Z'))).toBe(
      '2008-10-11',
    );
    expect(latestAllowedDateOfBirth(new Date('2028-02-29T10:00:00Z'))).toBe(
      '2010-02-28',
    );
  });
  it('rejects a date of birth under 18 and accepts exactly 18', () => {
    const latest = latestAllowedDateOfBirth();
    expect(() => assertValidDates({ dateOfBirth: latest })).not.toThrow();
    const tooYoung = new Date(latest + 'T00:00:00Z');
    tooYoung.setUTCDate(tooYoung.getUTCDate() + 1);
    expect(() =>
      assertValidDates({ dateOfBirth: tooYoung.toISOString().slice(0, 10) }),
    ).toThrow('at least 18');
    expect(() => assertValidDates({ dateOfBirth: '2016-05-01' })).toThrow(
      'at least 18',
    );
  });
});

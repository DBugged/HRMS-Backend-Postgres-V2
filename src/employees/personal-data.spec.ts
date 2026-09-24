import {
  areMandatoryDocumentsUploaded,
  isProfileComplete,
  mergePersonalData,
} from './personal-data';

const COMPLETE_FIELDS = {
  fullNameAsPerGovtId: 'Jane Doe',
  dateOfBirth: '1990-01-01',
  gender: 'Female',
  maritalStatus: 'Single',
  currentAddress: '123 Main St',
  fatherName: 'John Doe',
  emergencyContact1Number: '+91 98765 43210',
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

  it('is true once all 8 required fields are present', () => {
    expect(isProfileComplete(COMPLETE_FIELDS)).toBe(true);
  });

  it('ignores fields outside the required set', () => {
    expect(
      isProfileComplete({ ...COMPLETE_FIELDS, bloodGroup: undefined }),
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

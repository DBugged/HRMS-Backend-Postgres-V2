import { isProfileComplete, mergePersonalData } from './personal-data';

const COMPLETE_FIELDS = {
  fullNameAsPerGovtId: 'Jane Doe',
  dateOfBirth: '1990-01-01',
  gender: 'Female',
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

describe('mergePersonalData', () => {
  it('merges the patch onto the current data without dropping other fields', () => {
    const current = { personalEmail: 'jane@personal.test', bloodGroup: 'O+' };
    const merged = mergePersonalData(current, { bloodGroup: 'A+' });
    expect(merged.personalEmail).toBe('jane@personal.test');
    expect(merged.bloodGroup).toBe('A+');
  });

  it('sets profileCompleted true and stamps profileCompletedAt the first time all required fields are present', () => {
    const merged = mergePersonalData({}, COMPLETE_FIELDS);
    expect(merged.profileCompleted).toBe(true);
    expect(typeof merged.profileCompletedAt).toBe('string');
  });

  it('keeps the original profileCompletedAt on a later merge, does not re-stamp it', () => {
    const first = mergePersonalData({}, COMPLETE_FIELDS);
    const second = mergePersonalData(first, { bloodGroup: 'B+' });
    expect(second.profileCompletedAt).toBe(first.profileCompletedAt);
  });

  it('clears profileCompletedAt if a later merge removes a required field', () => {
    const first = mergePersonalData({}, COMPLETE_FIELDS);
    const second = mergePersonalData(first, { fatherName: '' });
    expect(second.profileCompleted).toBe(false);
    expect(second.profileCompletedAt).toBeNull();
  });
});

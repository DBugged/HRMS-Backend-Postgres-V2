import { profileScore, withAccountFields, withRootGender } from './profile-score';

const FULL: Record<string, string> = {
  fullNameAsPerGovtId: 'A', dateOfBirth: '1990-01-01', gender: 'F', maritalStatus: 'S', bloodGroup: 'O+', currentAddress: 'x',
  personalEmail: 'a@b.com', fatherName: 'f', fatherContact: '1', motherName: 'm', motherContact: '2',
  emergencyContact1Name: 'e', emergencyContact1Number: '3', emergencyContact2Name: 'e', emergencyContact2Number: '4',
  totalExperience: '2', currentOrganization: 'o', relevantExperience: '2',
  bankAccountHolderName: 'A', bankName: 'B', bankAccountNo: '123', bankIFSC: 'X', panNumber: 'ABCDE1234F',
  aadharNumber: '123412341234', cancelledChequeUrl: 'orgs/o/cheque.png',
  contactNumber: '+91 98765 43210', profileImage: 'p.png', designation: 'Dev', departmentId: 'd1', employeeCategory: 'Staff', workLocationId: 'w1',
};
const req = (name: string, isMandatory = true) => ({ name, isMandatory, isActive: true });

describe('profileScore', () => {
  it('is 100% and payroll-ready with everything filled and no documents required', () => {
    expect(profileScore(FULL, [], [])).toMatchObject({ percent: 100, missing: [], payrollReady: true });
  });

  it('lists what is missing and lowers the percentage', () => {
    const { bankIFSC: _ifsc, bloodGroup: _bg, ...rest } = FULL;
    void _ifsc; void _bg;
    const s = profileScore(rest, [], []);
    expect(s.missing.map((m) => m.key).sort()).toEqual(['bankIFSC', 'bloodGroup']);
    expect(s.percent).toBe(Math.round((29 / 31) * 100));
    expect(s.payrollReady).toBe(false);
  });

  it('stays payroll-ready when only a non-payroll field is missing', () => {
    const { bloodGroup: _bg, ...rest } = FULL;
    void _bg;
    expect(profileScore(rest, [], []).payrollReady).toBe(true);
  });

  it('treats blank text as missing', () => {
    expect(profileScore({ ...FULL, panNumber: '   ' }, [], []).missing.map((m) => m.key)).toEqual(['panNumber']);
  });

  it('counts a mandatory document until one that is not rejected is uploaded', () => {
    const none = profileScore(FULL, [req('PAN Card')], []);
    expect(none.missing[0]).toMatchObject({ key: 'doc:PAN Card', group: 'Documents' });
    expect(profileScore(FULL, [req('PAN Card')], [{ docType: 'PAN Card', status: 'REJECTED' }]).percent).toBeLessThan(100);
    expect(profileScore(FULL, [req('PAN Card')], [{ docType: 'PAN Card', status: 'PENDING' }]).percent).toBe(100);
  });

  it('ignores optional and inactive requirements', () => {
    expect(profileScore(FULL, [req('Other', false), { name: 'Old', isMandatory: true, isActive: false }], []).percent).toBe(100);
  });

  it('handles no personal data at all', () => {
    expect(profileScore(null, [], [])).toMatchObject({ percent: 0, payrollReady: false });
  });

  it('counts the gender saved on the employee record, not only the one in the personal data', () => {
    const { gender: _g, ...noGender } = FULL;
    expect(profileScore(noGender, [], []).missing.map((m) => m.key)).toContain('gender');
    expect(profileScore(withRootGender(noGender, 'FEMALE'), [], [])).toMatchObject({ percent: 100, missing: [] });
    // A gender already in the personal data is left alone.
    expect(withRootGender({ gender: 'Male' }, 'FEMALE').gender).toBe('Male');
  });

  it('counts the employee-record fields (contact number, photo, job details)', () => {
    const { contactNumber: _c, profileImage: _p, ...rest } = FULL;
    expect(profileScore(rest, [], []).missing.map((m) => m.key).sort()).toEqual(['contactNumber', 'profileImage']);
    const account = withAccountFields({}, { contactNumber: '1', profileImage: 'p', designation: 'D', departmentId: 'x', employeeCategory: 'S', workLocationId: 'w' });
    expect(account).toMatchObject({ contactNumber: '1', designation: 'D', workLocationId: 'w' });
  });

  it('asks for a UAN only where PF applies and the person has one', () => {
    expect(profileScore(FULL, [], [], { uanRequired: true }).missing.map((m) => m.key)).toEqual(['uanNumber']);
    expect(profileScore({ ...FULL, uanNumber: '1' }, [], [], { uanRequired: true }).missing).toEqual([]);
    expect(profileScore({ ...FULL, noUanYet: true }, [], [], { uanRequired: true }).missing).toEqual([]);
    expect(profileScore(FULL, [], [], { uanRequired: false }).missing).toEqual([]);
  });
});

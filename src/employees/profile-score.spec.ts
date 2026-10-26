import { profileScore } from './profile-score';

const FULL: Record<string, string> = {
  fullNameAsPerGovtId: 'A', dateOfBirth: '1990-01-01', gender: 'F', maritalStatus: 'S', bloodGroup: 'O+', currentAddress: 'x',
  personalEmail: 'a@b.com', fatherName: 'f', fatherContact: '1', motherName: 'm', motherContact: '2',
  emergencyContact1Name: 'e', emergencyContact1Number: '3', emergencyContact2Name: 'e', emergencyContact2Number: '4',
  totalExperience: '2', currentOrganization: 'o', relevantExperience: '2',
  bankAccountHolderName: 'A', bankName: 'B', bankAccountNo: '123', bankIFSC: 'X', panNumber: 'ABCDE1234F',
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
    expect(s.percent).toBe(Math.round((21 / 23) * 100));
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
});

import { companyInitials, uniqueEmployeeIdPrefix } from './employee-id-prefix';

describe('companyInitials', () => {
  it('takes the initials of the words', () => {
    expect(companyInitials('Demo Company')).toBe('DC');
    expect(companyInitials('Acme Retail Services')).toBe('ARS');
  });
  it('ignores legal endings and filler words', () => {
    expect(companyInitials('Sharma Traders Pvt Ltd')).toBe('ST');
    expect(companyInitials('The House of Gold Private Limited')).toBe('HG');
  });
  it('takes at most 4 letters, and the first 3 letters of a single word', () => {
    expect(companyInitials('One Two Three Four Five')).toBe('OTTF');
    expect(companyInitials('Acme')).toBe('ACM');
  });
  it('copes with accents, punctuation and nothing usable', () => {
    expect(companyInitials('Élan & Co.')).toBe('EC');
    expect(companyInitials('***')).toBe('EMP');
    expect(companyInitials(undefined)).toBe('EMP');
  });
});

describe('uniqueEmployeeIdPrefix', () => {
  it('is the base with a dash when nothing clashes', () => {
    expect(uniqueEmployeeIdPrefix('DC', ['AB-', 'XY-'])).toBe('DC-');
  });
  it('adds a number when the prefix is taken, ignoring case', () => {
    expect(uniqueEmployeeIdPrefix('DC', ['dc-'])).toBe('DC2-');
    expect(uniqueEmployeeIdPrefix('DC', ['DC-', 'DC2-'])).toBe('DC3-');
  });
  it('does not treat a longer prefix as a clash (DC-00001 and DCX-00001 are different IDs), but a nested one is', () => {
    expect(uniqueEmployeeIdPrefix('DC', ['DCX-'])).toBe('DC-');
    expect(uniqueEmployeeIdPrefix('DC', ['DC-1'])).toBe('DC2-');
  });
});

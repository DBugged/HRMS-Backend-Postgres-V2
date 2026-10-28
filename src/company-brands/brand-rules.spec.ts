import { employeeIdPrefixOf, isValidEmployeeIdFormat, nextEmployeeId, prefixesClash, resolveBranding, type BrandFields, type OrgBranding } from './brand-rules';

const ORG: OrgBranding = {
  companyName: 'Parent Co', name: 'parent', legalName: 'Parent Co Pvt Ltd', companyLogoUrl: 'org/logo.png', emailLogoUrl: 'org/email.png',
  registeredAddress: 'Parent Street', contactEmail: 'hr@parent.test', phone: '111', website: 'https://parent.test',
};
const BRAND: BrandFields = {
  id: 'b1', name: 'Sister A', legalName: null, logoUrl: 'org/a.png', emailLogoUrl: null, address: 'A Street', contactEmail: null, phone: null, website: null,
};

describe('employee ID format', () => {
  it('accepts a short prefix and one counter token', () => {
    expect(isValidEmployeeIdFormat('SA-{00000}')).toBe(true);
    expect(isValidEmployeeIdFormat('SIS_B/{0001}')).toBe(true);
  });
  it.each(['{00000}', 'SA-', 'SA-{0}', 'SA-{00000}-X', 'SA {00000}', 'WAYTOOLONGPREFIX1-{00000}', 'SA-{YYYY}{00000}'])('rejects %s', (f) => {
    expect(isValidEmployeeIdFormat(f)).toBe(false);
  });
  it('reads the prefix and the next ID', () => {
    expect(employeeIdPrefixOf('SA-{00000}')).toBe('SA-');
    expect(employeeIdPrefixOf('DP-{00000}')).toBe('DP-');
    expect(employeeIdPrefixOf(null)).toBe('');
    expect(nextEmployeeId('SA-{00000}', 0)).toBe('SA-00001');
    expect(nextEmployeeId('SA-{00000}', 41)).toBe('SA-00042');
  });
});

describe('prefixesClash', () => {
  it('flags the same prefix, or one that starts the other, ignoring case', () => {
    expect(prefixesClash('SA-', 'sa-')).toBe(true);
    expect(prefixesClash('SA-', 'SA-1')).toBe(true);
    expect(prefixesClash('SA-', 'SB-')).toBe(false);
  });
  it('never clashes with a blank prefix', () => {
    expect(prefixesClash('', 'SA-')).toBe(false);
  });
});

describe('resolveBranding', () => {
  it('is exactly the organization when there is no brand', () => {
    expect(resolveBranding(ORG, null)).toEqual({
      brandId: null, companyName: 'Parent Co', legalName: 'Parent Co Pvt Ltd', logoUrl: 'org/logo.png', emailLogoUrl: 'org/email.png',
      address: 'Parent Street', contactEmail: 'hr@parent.test', phone: '111', website: 'https://parent.test',
    });
  });

  it('uses the brand where it has a value and the organization where it does not', () => {
    const r = resolveBranding(ORG, BRAND);
    expect(r).toMatchObject({ brandId: 'b1', companyName: 'Sister A', logoUrl: 'org/a.png', address: 'A Street' });
    expect(r.contactEmail).toBe('hr@parent.test');
    expect(r.legalName).toBe('Parent Co Pvt Ltd');
  });

  it('uses the brand logo for email when it has no separate email logo', () => {
    expect(resolveBranding(ORG, BRAND).emailLogoUrl).toBe('org/a.png');
  });

  it('falls back to the organization name, then its internal name, when there is no company name', () => {
    expect(resolveBranding({ ...ORG, companyName: '  ' }, null).companyName).toBe('parent');
  });

  it('treats a blank brand field as unset', () => {
    expect(resolveBranding(ORG, { ...BRAND, name: ' ', logoUrl: '' }).companyName).toBe('Parent Co');
    expect(resolveBranding(ORG, { ...BRAND, name: ' ', logoUrl: '' }).logoUrl).toBe('org/logo.png');
  });
});

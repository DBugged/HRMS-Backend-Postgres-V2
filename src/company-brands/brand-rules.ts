// Purpose: the rules for company brands - what a valid employee ID series looks like, how to tell two series apart, and which name,
//   logo and address a person's documents carry (their brand's, or the organization's own when they have none).
// Responsibilities: pure functions (no database) shared by the brand API, the employee ID generator, the lookup and the tests.
// Important: an employee with no brand, or a brand field left blank, always resolves to the organization's own value - so a company
//   that never adds a brand produces exactly the documents it did before.
import { formatDocumentNumber } from '../organizations/document-numbering';

// A brand's employee ID format is a literal prefix, then one counter token: 'SA-{00000}'. The prefix is what keeps two series from
// ever producing the same ID, so it is required.
const FORMAT_RE = /^([A-Za-z0-9_\-./]{1,12})\{(\d{3,8})\}$/;

export const EMPLOYEE_ID_FORMAT_MESSAGE =
  "Use 1-12 letters, digits or - _ . / followed by a counter such as {00000}, for example SA-{00000}.";

export function isValidEmployeeIdFormat(format: string): boolean {
  return FORMAT_RE.test(format);
}

/** The literal text before the counter ('SA-' for 'SA-{00000}'); for any other format, the text before the first '{'. */
export function employeeIdPrefixOf(format: string | null | undefined): string {
  if (!format) return '';
  const m = FORMAT_RE.exec(format);
  return m ? m[1] : format.split('{')[0];
}

/** Whether two ID series could collide: one prefix is the start of the other (SA- and SA-1 would). Compared case-insensitively. */
export function prefixesClash(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** The ID the series would issue after `counter` numbers have been used. */
export function nextEmployeeId(format: string, counter: number): string {
  return formatDocumentNumber(format, counter + 1);
}

export interface OrgBranding {
  companyName: string | null;
  name: string;
  legalName: string | null;
  companyLogoUrl: string | null;
  emailLogoUrl: string | null;
  registeredAddress: string | null;
  contactEmail: string | null;
  phone: string | null;
  website: string | null;
}

export interface BrandFields {
  id: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  emailLogoUrl: string | null;
  address: string | null;
  contactEmail: string | null;
  phone: string | null;
  website: string | null;
}

export interface ResolvedBranding {
  // null when the organization's own branding applies.
  brandId: string | null;
  companyName: string;
  legalName: string | null;
  logoUrl: string | null;
  emailLogoUrl: string | null;
  address: string | null;
  contactEmail: string | null;
  phone: string | null;
  website: string | null;
}

const text = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** The branding for a document: each field from the brand when it has one, else from the organization. */
export function resolveBranding(org: OrgBranding, brand: BrandFields | null | undefined): ResolvedBranding {
  const orgName = text(org.companyName) ?? org.name;
  return {
    brandId: brand?.id ?? null,
    companyName: text(brand?.name) ?? orgName,
    legalName: text(brand?.legalName) ?? text(org.legalName),
    logoUrl: text(brand?.logoUrl) ?? text(org.companyLogoUrl),
    emailLogoUrl: text(brand?.emailLogoUrl) ?? text(brand?.logoUrl) ?? text(org.emailLogoUrl) ?? text(org.companyLogoUrl),
    address: text(brand?.address) ?? text(org.registeredAddress),
    contactEmail: text(brand?.contactEmail) ?? text(org.contactEmail),
    phone: text(brand?.phone) ?? text(org.phone),
    website: text(brand?.website) ?? text(org.website),
  };
}

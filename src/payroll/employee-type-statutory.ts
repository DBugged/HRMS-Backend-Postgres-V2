// Purpose: Which statutory schemes an employee type starts with. A person hired as an intern, trainee or apprentice is on
//   a stipend (no PF, ESI, gratuity or statutory bonus); a consultant, freelancer or vendor resource is not on the payroll
//   at all (professional fees, not salary); everyone else is an employee under the schemes.
// Important: only a starting point - HR can tick or untick each scheme per employee when the salary structure is built.
//   A fixed-term or contract employee's gratuity is paid after one year of service (Code on Social Security, 2020).
export interface StatutoryDefaults {
  pf: boolean;
  esi: boolean;
  gratuity: boolean;
  bonus: boolean;
}

const ALL: StatutoryDefaults = {
  pf: true,
  esi: true,
  gratuity: true,
  bonus: true,
};
const NONE: StatutoryDefaults = {
  pf: false,
  esi: false,
  gratuity: false,
  bonus: false,
};

const BY_TYPE: Record<string, StatutoryDefaults> = {
  permanent: ALL,
  probation: ALL,
  contract: ALL,
  temporary: ALL,
  part_time: ALL,
  intern: NONE,
  trainee: NONE,
  apprentice: NONE,
  consultant: NONE,
  freelancer: NONE,
  vendor_resource: NONE,
  third_party_payroll: NONE,
};

/** Types that are not employees of this organisation's payroll (paid fees or by another employer). */
export const OFF_PAYROLL_TYPES = new Set([
  'consultant',
  'freelancer',
  'vendor_resource',
  'third_party_payroll',
]);

export function statutoryDefaultsForType(
  employeeType?: string | null,
): StatutoryDefaults {
  const key = (employeeType ?? '').trim().toLowerCase();
  return { ...(BY_TYPE[key] ?? ALL) };
}

/** Years of service after which gratuity is payable: one for fixed-term / contract staff, five for others. */
export function gratuityYearsFor(employeeType?: string | null): number {
  const key = (employeeType ?? '').trim().toLowerCase();
  return key === 'contract' || key === 'temporary' ? 1 : 5;
}

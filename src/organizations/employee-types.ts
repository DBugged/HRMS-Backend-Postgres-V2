// Purpose: The 12 built-in Employee Type values, mirrored exactly from frontend/src/constants/
//   employeeTypes.tsx's DEFAULT_EMPLOYEE_TYPES.
// Important: `value` is compared directly elsewhere ('probation' drives employmentStatus assignment at
//   EmployeesService.create() time) — never rename an existing value here, only add new ones.

export interface EmployeeTypeEntry {
  value: string;
  label: string;
  // Custom entries only — built-ins are always active (mirrors their
  // existing edit/delete immutability; see EmployeeTypesService.update()/
  // setActive()). Optional so pre-existing custom entries (created before
  // this field existed) default to active via `?? true` at read time.
  isActive?: boolean;
}

export const DEFAULT_EMPLOYEE_TYPES: EmployeeTypeEntry[] = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'probation', label: 'Probation' },
  { value: 'contract', label: 'Contract' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'intern', label: 'Intern' },
  { value: 'apprentice', label: 'Apprentice' },
  { value: 'freelancer', label: 'Freelancer' },
  { value: 'part_time', label: 'Part-Time' },
  { value: 'temporary', label: 'Temporary' },
  { value: 'trainee', label: 'Trainee' },
  { value: 'third_party_payroll', label: 'Third-Party Payroll' },
  { value: 'vendor_resource', label: 'Vendor Resource' },
];

// Same slug derivation as the existing inline "add new type" flow in
// Employees.tsx's addEmployeeType() — kept identical so a value created via
// either path collides/dedupes correctly against the other.
export function slugifyEmployeeType(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

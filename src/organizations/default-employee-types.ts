// Every org starts with these — Organization.customEmployeeTypes lets an
// org extend the list (User.employeeType is a plain string, not an enum).
// Values keep the old system's lowercase convention: 'probation' in
// particular is compared against directly elsewhere (probation workflow),
// so it's load-bearing, not just a display label.
export interface EmployeeTypeOption {
  value: string;
  label: string;
}

export const DEFAULT_EMPLOYEE_TYPES: EmployeeTypeOption[] = [
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
  { value: 'third_party_payroll', label: 'Third Party Payroll' },
  { value: 'vendor_resource', label: 'Vendor Resource' },
];

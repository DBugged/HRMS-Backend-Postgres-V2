// SalaryComponent.code and LeaveType.code are free-text fields an admin
// can set/rename via the API — nothing in the schema pins these specific
// values. But payroll/dashboard/reports/settlements/leave-encashments/
// leaves all independently look components up by exactly these strings
// (matching the seeded defaults in salary-component-defaults.ts /
// leave-type-defaults.ts). Centralizing them here doesn't stop an admin
// from renaming the underlying record, but it turns ~15 scattered literal
// occurrences into one place that documents the coupling and is
// git-grep-able.
export const SALARY_COMPONENT_CODES = {
  BASIC: 'BASIC',
  HRA: 'HRA',
  PF: 'PF',
  PF_EMPLOYER: 'PF_EMPLOYER',
  ESI: 'ESI',
  ESI_EMPLOYER: 'ESI_EMPLOYER',
  PT: 'PT',
  LWF: 'LWF',
  INCOME_TAX: 'INCOME_TAX',
} as const;

export const LEAVE_TYPE_CODES = {
  COMPOFF: 'COMPOFF',
} as const;

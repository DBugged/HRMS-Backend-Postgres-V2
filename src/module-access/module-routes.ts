// Purpose: which HRMS module each API route belongs to, so a company's switched-off modules can be refused in one place.
// Important: keyed by the FIRST path segment. Routes not listed (employees, auth, dashboard, organizations, ...) are core
//   and always available. Add a new module's routes here and a flag in cc_feature_flags.
export const MODULE_LABELS: Record<string, string> = {
  'module.attendance': 'Attendance',
  'module.leave': 'Leave',
  'module.payroll': 'Payroll',
  'module.statutory': 'Statutory compliance',
  'module.loans_reimbursements': 'Loans and reimbursements',
  'module.assets': 'Assets',
  'module.performance': 'Performance',
  'module.documents_letters': 'Documents and letters',
  'module.offboarding': 'Offboarding',
  'module.reports': 'Reports',
  'module.policy_assistant': 'Policy assistant',
};

const SEGMENTS: Record<string, string[]> = {
  'module.attendance': ['attendance', 'work-schedules', 'overtime'],
  'module.leave': ['leaves', 'leave-balances', 'leave-encashments', 'leave-grants', 'leave-tracker', 'leave-types', 'leave-year', 'comp-offs'],
  'module.payroll': ['payroll', 'payroll-settings', 'payroll-templates', 'employee-salary', 'salary-components', 'opening-balances'],
  'module.statutory': ['statutory-config', 'tds', 'tax-slabs', 'tax-declarations'],
  'module.loans_reimbursements': ['loans', 'reimbursements'],
  'module.assets': ['assets'],
  'module.performance': ['performance-ratings', 'company-performance'],
  'module.documents_letters': ['documents', 'letter-templates'],
  'module.offboarding': ['offboarding', 'resignations', 'settlements'],
  'module.reports': ['reports'],
  'module.policy_assistant': ['policy-assistant'],
};

const BY_SEGMENT = new Map(Object.entries(SEGMENTS).flatMap(([mod, segs]) => segs.map((s) => [s, mod] as const)));

/** The module a request path belongs to, or null for core routes. `/employees/:id/letters` is Documents and letters. */
export function moduleForPath(path: string): string | null {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'employees' && parts[2] === 'letters') return 'module.documents_letters';
  return BY_SEGMENT.get(parts[0]) ?? null;
}

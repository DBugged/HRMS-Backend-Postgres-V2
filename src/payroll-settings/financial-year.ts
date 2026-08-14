/**
 * Ported verbatim from the old backend's taxEngine.js getFinancialYear.
 * India's fiscal year doesn't run Jan-Dec, so "financial year" is a
 * distinct concept from calendar year everywhere payroll/tax logic
 * touches it (LeaveEncashment, TaxSlabConfig, EmployeeTaxDeclaration, and
 * eventually PayrollRun).
 */
export function getFinancialYear(
  month: number,
  year: number,
  startMonth: number,
): string {
  if (month >= startMonth) {
    return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  }
  return `${year - 1}-${String(year % 100).padStart(2, '0')}`;
}

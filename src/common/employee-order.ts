import type { Prisma } from '@prisma/client';

// Default ordering for every employee list / per-employee row set:
// employee ID ascending, then name ascending as tiebreak.

// For queries on the User model directly. The DB compares strings, which is
// correct for fixed-width IDs (DP-00009 < DP-00010); use compareEmployees
// for in-memory sorts where widths or prefixes may vary.
export const EMPLOYEE_ORDER_BY: Prisma.UserOrderByWithRelationInput[] = [
  { employeeId: 'asc' },
  { name: 'asc' },
];

// For models with an `employee` relation to User (attendance, payslip,
// loan, leave balance, ...).
export const EMPLOYEE_RELATION_ORDER_BY: {
  employee: { employeeId?: Prisma.SortOrder; name?: Prisma.SortOrder };
}[] = [{ employee: { employeeId: 'asc' } }, { employee: { name: 'asc' } }];

const collator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

// Natural, numeric-aware comparison of employee IDs: DP-00010 after
// DP-00009, and mixed prefixes (EMP-2 vs DP-10) are ordered stably.
export function compareEmployeeId(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return collator.compare(a ?? '', b ?? '');
}

// Comparator for in-memory rows: employee ID (natural) then name.
export function compareEmployees(
  a: { employeeId?: string | null; name?: string | null },
  b: { employeeId?: string | null; name?: string | null },
): number {
  return (
    compareEmployeeId(a.employeeId, b.employeeId) ||
    collator.compare(a.name ?? '', b.name ?? '')
  );
}

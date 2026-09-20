// Effective work location of an employee: the per-employee override (User.workLocationId) wins, otherwise the
// department's location. Pure helper so geofence, attendance and statutory-state resolution share one rule.
export function effectiveWorkLocation<T>(employee: {
  workLocation?: T | null;
  department?: { workLocation?: T | null } | null;
}): T | null {
  return employee.workLocation ?? employee.department?.workLocation ?? null;
}

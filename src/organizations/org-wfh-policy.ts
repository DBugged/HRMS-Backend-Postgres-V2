// Purpose: The company's Work From Home allowance (Organization Settings > Policies): how many WFH days an employee may
//   have in a month. Shown on the profile as "used / allowed"; it is informational - requests are not refused over it.
// Important: blank / unset means no limit (null), and 0 is a real value (no WFH days). Stored in Organization.policies.
export function wfhDaysPerMonthOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 31 ? n : null;
}

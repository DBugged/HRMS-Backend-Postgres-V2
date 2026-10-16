// Purpose: What an employee may learn about a hold on their own salary.
// Responsibilities: keep "your salary is on hold" (heldAt) visible so the app can say so, and strip who placed the hold
//   and the reason - HR notes (e.g. an inquiry or unreturned asset) are not for the payslip API an employee reads.
// Important: pure; applied by the service to every payslip row returned to an EMPLOYEE or MANAGER.
export function redactHoldForEmployee<
  T extends { holdReason?: string | null; heldById?: string | null },
>(run: T): T {
  return { ...run, holdReason: null, heldById: null };
}

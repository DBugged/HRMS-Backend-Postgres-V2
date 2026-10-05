// Purpose: The single answer to "is overtime being paid?" for the whole backend.
// Important: overtime is paid through the Overtime Pay salary component (code OVERTIME_PAY, see
//   salary-component-defaults.ts) and payroll only runs active components, so that component's Active switch is the
//   switch. When it is off, overtime can never reach a payslip, so logging it, auto-suggesting it from a punch-out and
//   editing its pay rates would only create approved overtime that is never paid. (The org preference
//   `enableOvertime` is not read anywhere and is not the source of truth.)
import type { Prisma } from '@prisma/client';

export const OVERTIME_PAY_CODE = 'OVERTIME_PAY';

export const OVERTIME_PAY_OFF_MESSAGE =
  'Overtime Pay is turned off in payroll, so overtime cannot be logged. Ask HR to turn on the Overtime Pay component in Salary Components.';

export async function isOvertimePayEnabled(
  db: Pick<Prisma.TransactionClient, 'salaryComponent'>,
  organizationId: string,
): Promise<boolean> {
  const active = await db.salaryComponent.count({
    where: { organizationId, code: OVERTIME_PAY_CODE, isActive: true },
  });
  return active > 0;
}

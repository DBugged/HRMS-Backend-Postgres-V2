// Purpose: One rule for every write that changes the inputs of a payroll month (leave, overtime, attendance).
// A run that is LOCKED or PAID has already charged loans/encashments and been paid on - changing its inputs would
// leave the payslip silently disagreeing with the records, so an Admin must unlock it first. A VERIFIED or
// APPROVED run has been signed off on figures that the change would invalidate, and calculate()/adjust() won't
// touch an APPROVED run, so it is sent back to CALCULATED where it must be recalculated and re-approved.
import { BadRequestException } from '@nestjs/common';
import { PayrollRunStatus, type Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'payrollRun'>;
export interface PayrollMonth {
  month: number;
  year: number;
}

// Every distinct (month, year) between two YYYY-MM-DD dates, inclusive.
export function monthsBetween(
  startDate: string,
  endDate: string,
): PayrollMonth[] {
  const months: PayrollMonth[] = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export async function assertPayrollMonthsUnlocked(
  db: Db,
  organizationId: string,
  employeeId: string,
  months: PayrollMonth[],
  what: string,
): Promise<void> {
  if (months.length === 0) return;
  const locked = await db.payrollRun.findFirst({
    where: {
      organizationId,
      employeeId,
      isFinalSettlement: false,
      status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
      OR: months,
    },
    select: { month: true, year: true, status: true },
  });
  if (locked) {
    throw new BadRequestException(
      `This ${what} falls within the ${locked.month}/${locked.year} payroll period, which is already ${locked.status.toLowerCase()}. Ask an Admin to unlock that payroll run first.`,
    );
  }
}

// Sends a signed-off (VERIFIED/APPROVED) run for these months back to CALCULATED so it is recalculated.
export async function reopenSignedOffPayrollMonths(
  db: Db,
  organizationId: string,
  employeeId: string,
  months: PayrollMonth[],
): Promise<number> {
  if (months.length === 0) return 0;
  const { count } = await db.payrollRun.updateMany({
    where: {
      organizationId,
      employeeId,
      isFinalSettlement: false,
      status: { in: [PayrollRunStatus.VERIFIED, PayrollRunStatus.APPROVED] },
      OR: months,
    },
    data: { status: PayrollRunStatus.CALCULATED },
  });
  return count;
}

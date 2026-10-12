// Purpose: which payroll runs the registers, bank file and statutory returns are built from.
// Responsibilities: one definition, so every report agrees on "final".
// Important: a run is final for reporting once it is LOCKED or PAID. An APPROVED run can still be sent back for
// recalculation (attendance, leave or overtime change) and has not had its loan / encashment effects applied, so a bank
// file or return built from it could differ from what is finally paid. The one exception is a final-settlement run,
// which the Settlements workflow creates already APPROVED and settles itself.
import { PayrollRunStatus, type Prisma } from '@prisma/client';

export const EXPORTABLE_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

export const EXPORTABLE_RUNS: Pick<Prisma.PayrollRunWhereInput, 'OR'> = {
  OR: [
    { status: { in: EXPORTABLE_RUN_STATUSES } },
    { isFinalSettlement: true, status: PayrollRunStatus.APPROVED },
  ],
};

// The same rule for runs already loaded.
export function isExportableRun(run: {
  status: PayrollRunStatus;
  isFinalSettlement: boolean;
}): boolean {
  return (
    EXPORTABLE_RUN_STATUSES.includes(run.status) ||
    (run.isFinalSettlement && run.status === PayrollRunStatus.APPROVED)
  );
}

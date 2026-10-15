// Purpose: Turn a month's locked payroll into the list the bank needs (who to pay, how much, to which account).
// Responsibilities: pick the runs that are ready to pay, check each employee's bank details, and say plainly who was
//   left out and why - a held salary, a zero net, a missing or malformed account - instead of producing a file that
//   the bank rejects row by row.
// Important: pure. The caller passes plaintext personalData (the scoped Prisma client decrypts it on read).

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface AdviceRun {
  id: string;
  employeeId: string;
  month: number;
  year: number;
  netPay: number;
  payslipNumber: string | null;
  heldAt: Date | null;
  holdReason: string | null;
  runLabel: string | null;
}

export interface AdviceEmployee {
  employeeId: string;
  name: string;
  personalData: unknown;
}

export interface BankAdviceRow {
  runId: string;
  employeeCode: string;
  name: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
  amount: number;
  narration: string;
  payslipNumber: string;
}

export interface BankAdviceLeftOut {
  runId: string;
  employeeCode: string;
  name: string;
  amount: number;
  reason: string;
}

export interface BankAdvice {
  rows: BankAdviceRow[];
  total: number;
  /** Not in the file, and what to do about it. */
  leftOut: BankAdviceLeftOut[];
}

// Four letters, a zero, then six letters or digits.
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const rupees = (n: number) => Math.round(n * 100) / 100;

export function buildBankAdvice(
  runs: AdviceRun[],
  employees: Map<string, AdviceEmployee>,
): BankAdvice {
  const rows: BankAdviceRow[] = [];
  const leftOut: BankAdviceLeftOut[] = [];

  for (const run of runs) {
    const emp = employees.get(run.employeeId);
    const base = {
      runId: run.id,
      employeeCode: emp?.employeeId ?? '',
      name: emp?.name ?? 'Unknown employee',
      amount: rupees(run.netPay),
    };
    const skip = (reason: string) => leftOut.push({ ...base, reason });

    if (run.heldAt) {
      skip(
        `Salary on hold${run.holdReason ? `: ${run.holdReason}` : ''}. Release the hold to pay.`,
      );
      continue;
    }
    if (!(run.netPay > 0)) {
      skip('Net pay is zero, so there is nothing to transfer.');
      continue;
    }
    const pd = (emp?.personalData ?? {}) as Record<string, unknown>;
    // Spaces and dashes are how people type account numbers; the bank wants digits only.
    const account = text(pd.bankAccountNo).replace(/[\s-]/g, '');
    const ifsc = text(pd.bankIFSC).replace(/\s/g, '').toUpperCase();
    if (!account || !ifsc) {
      skip(
        `${!account && !ifsc ? 'Bank account number and IFSC are' : !account ? 'Bank account number is' : 'IFSC is'} missing. Add it in the employee's profile.`,
      );
      continue;
    }
    if (!ACCOUNT.test(account)) {
      skip('Bank account number should be 9 to 18 digits.');
      continue;
    }
    if (!IFSC.test(ifsc)) {
      skip('IFSC should be 4 letters, a 0, then 6 letters or digits.');
      continue;
    }
    rows.push({
      runId: run.id,
      employeeCode: base.employeeCode,
      name: base.name,
      accountNumber: account,
      ifsc,
      bankName: text(pd.bankName),
      amount: base.amount,
      narration: run.runLabel
        ? run.runLabel
        : `Salary ${MONTHS[run.month - 1]} ${run.year}`,
      payslipNumber: run.payslipNumber ?? '',
    });
  }

  return {
    rows,
    total: rupees(rows.reduce((s, r) => s + r.amount, 0)),
    leftOut,
  };
}

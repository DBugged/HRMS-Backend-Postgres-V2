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
  /** First four letters of the IFSC - the beneficiary's bank, which the file can be split by. */
  bankCode: string;
  /** How the money moves: IFT inside the company's own bank, otherwise NEFT, or RTGS from 2 lakh up. */
  transferMode: TransferMode;
}

export type TransferMode = 'IFT' | 'NEFT' | 'RTGS';

/** RTGS is for large transfers: the usual cut-over is 2 lakh, below which NEFT is used. */
export const RTGS_MINIMUM = 200000;

export interface BankAdviceBank {
  code: string;
  /** The bank's name as typed on the employees' records (the most common one for this code). */
  name: string;
  count: number;
  total: number;
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
  /** The same payments grouped by the beneficiary's bank, largest first - for one file per bank. */
  banks: BankAdviceBank[];
  /** Not in the file, and what to do about it. */
  leftOut: BankAdviceLeftOut[];
}

// Four letters, a zero, then six letters or digits.
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const rupees = (n: number) => Math.round(n * 100) / 100;

export function transferModeFor(
  amount: number,
  ifsc: string,
  payerIfsc?: string | null,
): TransferMode {
  if (payerIfsc && payerIfsc.slice(0, 4) === ifsc.slice(0, 4)) return 'IFT';
  return amount >= RTGS_MINIMUM ? 'RTGS' : 'NEFT';
}

export function buildBankAdvice(
  runs: AdviceRun[],
  employees: Map<string, AdviceEmployee>,
  // The IFSC of the account the salary is paid from (Organization Settings): payments to the same bank are IFT.
  payerIfsc?: string | null,
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
      bankCode: ifsc.slice(0, 4),
      transferMode: transferModeFor(base.amount, ifsc, payerIfsc),
    });
  }

  const byBank = new Map<string, BankAdviceBank & { names: Map<string, number> }>();
  for (const r of rows) {
    const entry = byBank.get(r.bankCode) ?? {
      code: r.bankCode,
      name: '',
      count: 0,
      total: 0,
      names: new Map<string, number>(),
    };
    entry.count += 1;
    entry.total = rupees(entry.total + r.amount);
    if (r.bankName) entry.names.set(r.bankName, (entry.names.get(r.bankName) ?? 0) + 1);
    byBank.set(r.bankCode, entry);
  }
  const banks: BankAdviceBank[] = [...byBank.values()]
    .map(({ names, ...b }) => ({
      ...b,
      name: [...names.entries()].sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? b.code,
    }))
    .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));

  return {
    rows,
    total: rupees(rows.reduce((s, r) => s + r.amount, 0)),
    banks,
    leftOut,
  };
}

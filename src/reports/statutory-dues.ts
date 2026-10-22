// Purpose: One page of "what to pay, by when" for a month's statutory filings - PF, ESI, Professional Tax and Labour
//   Welfare Fund - put together from the figures the individual filings already work out.
// Important: pure. The amounts are the contributions deducted and owed per payroll; the portals' own challans are the
//   final word (for example the EPFO administration charge has a minimum per establishment).
export interface DueLine {
  label: string;
  amount: number;
}

export type DueKey = 'PF' | 'ESI' | 'PT' | 'LWF';

export interface StatutoryDue {
  key: DueKey;
  label: string;
  /** YYYY-MM-DD, or null when it follows each state's own schedule. */
  dueDate: string | null;
  amount: number;
  /** What the amount is made of. */
  lines: DueLine[];
  /** People covered. */
  members: number;
  /** The upload file / return for this filing is ready (no blocking problems). Null where there is no upload file. */
  fileReady: boolean | null;
  note: string;
}

const rupees = (n: number) => Math.round(n * 100) / 100;
const sum = (lines: DueLine[]) => rupees(lines.reduce((s, l) => s + l.amount, 0));

export interface DuesInput {
  pf: {
    members: number;
    ready: boolean;
    challan: { dueDate: string; epfAccount01: number; epsAccount10: number; edliAccount21: number; adminAccount02: number; note: string };
  };
  esi: { members: number; ready: boolean; dueDate: string; employeeContribution: number; employerContribution: number };
  pt: { states: { state: string; employees: number; totalPt: number; dueDate: string | null; dueNote: string }[] };
  lwf: { states: { state: string; employees: number; total: number; dueNote: string }[] };
}

export function buildStatutoryDues(input: DuesInput): { dues: StatutoryDue[]; total: number } {
  const dues: StatutoryDue[] = [];

  const pfLines: DueLine[] = [
    { label: 'A/c 01 - EPF (employee + employer share)', amount: input.pf.challan.epfAccount01 },
    { label: 'A/c 10 - EPS (pension)', amount: input.pf.challan.epsAccount10 },
    { label: 'A/c 21 - EDLI', amount: input.pf.challan.edliAccount21 },
    { label: 'A/c 02 - Administration charge', amount: input.pf.challan.adminAccount02 },
  ];
  if (input.pf.members > 0) {
    dues.push({ key: 'PF', label: 'Provident Fund', dueDate: input.pf.challan.dueDate, amount: sum(pfLines), lines: pfLines, members: input.pf.members, fileReady: input.pf.ready, note: input.pf.challan.note });
  }

  const esiLines: DueLine[] = [
    { label: 'Employee contribution', amount: input.esi.employeeContribution },
    { label: 'Employer contribution', amount: input.esi.employerContribution },
  ];
  if (input.esi.members > 0) {
    dues.push({ key: 'ESI', label: 'Employees State Insurance', dueDate: input.esi.dueDate, amount: sum(esiLines), lines: esiLines, members: input.esi.members, fileReady: input.esi.ready, note: 'Pay on the ESIC portal by the 15th of the next month.' });
  }

  if (input.pt.states.length > 0) {
    const lines = input.pt.states.map((s) => ({ label: s.state, amount: s.totalPt }));
    // The earliest state due date is the one to watch; states without a published date follow their own rules.
    const dates = input.pt.states.map((s) => s.dueDate).filter((d): d is string => !!d).sort();
    dues.push({ key: 'PT', label: 'Professional Tax', dueDate: dates[0] ?? null, amount: sum(lines), lines, members: input.pt.states.reduce((s, x) => s + x.employees, 0), fileReady: null, note: 'Each state files on its own portal and due date - confirm the date for every state.' });
  }

  if (input.lwf.states.length > 0) {
    const lines = input.lwf.states.map((s) => ({ label: s.state, amount: s.total }));
    dues.push({ key: 'LWF', label: 'Labour Welfare Fund', dueDate: null, amount: sum(lines), lines, members: input.lwf.states.reduce((s, x) => s + x.employees, 0), fileReady: null, note: "Due dates follow each state's own LWF schedule - confirm on the state portal." });
  }

  return { dues, total: sum(dues.map((d) => ({ label: d.label, amount: d.amount }))) };
}

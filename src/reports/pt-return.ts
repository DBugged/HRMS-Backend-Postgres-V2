// Purpose: Pure grouping for the monthly Professional Tax return working papers — employee-wise rows by state, a
//   per-state summary with the slab-wise head-count and tax Maharashtra-style returns ask for, and each state's
//   filing due date.
// Important: PT returns are filed on each state's own portal in that state's own layout; this produces the data to
//   fill them, not a state-specific upload file. Due dates are the commonly published ones — confirm with the state.

export interface PtMemberInput {
  state: string;
  employeeCode: string;
  name: string;
  gender: string | null;
  wages: number;
  pt: number;
}

export interface PtStateSummary {
  state: string;
  employees: number;
  employeesWithTax: number;
  totalWages: number;
  totalPt: number;
  slabs: { amount: number; employees: number; tax: number }[];
  dueDate: string | null;
  dueNote: string;
}

export const NO_STATE = 'State not set';

const nextMonth = (month: number, year: number) =>
  month === 12 ? { m: 1, y: year + 1 } : { m: month + 1, y: year };

// Monthly-return due day (of the following month) for states where it is widely published.
const DUE_DAY: Record<string, number> = {
  Maharashtra: 15,
  Karnataka: 20,
  Telangana: 10,
  'West Bengal': 21,
};

export function ptDueDate(
  state: string,
  month: number,
  year: number,
): { date: string | null; note: string } {
  const day = DUE_DAY[state];
  if (!day) {
    return {
      date: null,
      note: "Filing frequency and due date follow this state's own rules — confirm on the state portal.",
    };
  }
  const n = nextMonth(month, year);
  return {
    date: `${n.y}-${String(n.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    note: 'Monthly filers; annual / lower-liability filers follow a different schedule — confirm with the state.',
  };
}

export function buildPtReturn(
  members: PtMemberInput[],
  month: number,
  year: number,
) {
  const byState = new Map<string, PtMemberInput[]>();
  for (const m of members) {
    const key = m.state || NO_STATE;
    byState.set(key, [...(byState.get(key) ?? []), m]);
  }
  const states: PtStateSummary[] = [...byState.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, list]) => {
      const slabMap = new Map<number, { employees: number; tax: number }>();
      for (const m of list) {
        const cur = slabMap.get(m.pt) ?? { employees: 0, tax: 0 };
        cur.employees += 1;
        cur.tax += m.pt;
        slabMap.set(m.pt, cur);
      }
      const due = ptDueDate(state, month, year);
      return {
        state,
        employees: list.length,
        employeesWithTax: list.filter((m) => m.pt > 0).length,
        totalWages: list.reduce((s, m) => s + m.wages, 0),
        totalPt: list.reduce((s, m) => s + m.pt, 0),
        slabs: [...slabMap.entries()]
          .sort(([a], [b]) => a - b)
          .map(([amount, v]) => ({ amount, ...v })),
        dueDate: due.date,
        dueNote: due.note,
      };
    });
  return {
    states,
    totals: {
      employees: members.length,
      totalWages: members.reduce((s, m) => s + m.wages, 0),
      totalPt: members.reduce((s, m) => s + m.pt, 0),
    },
    warnings: byState.has(NO_STATE)
      ? [
          `${byState.get(NO_STATE)!.length} employee(s) have no work-location state, so their PT cannot be placed in a state return.`,
        ]
      : [],
  };
}

// Purpose: A person's monthly Basic, for the overtime report's pay estimate.
// Responsibilities: reads it from the salary structure the way a person is actually set up - a fixed amount, a percentage of
//   CTC or of another fixed component - and, when the structure cannot give a figure (a formula or a manually entered Basic),
//   falls back to the largest Basic on the person's last three payroll runs.
// Important: an estimate only. Payroll is the source of truth; a part-month run can show a Basic lower than the full rate,
//   which is why the largest of the last three is used. null = no figure could be found.
export interface StructureRow {
  componentCode: string;
  valueType: string;
  fixedAmount: number | null;
  percentageValue: number | null;
  percentageOf: string | null;
  amountBasis: string;
}

const monthly = (r: StructureRow): number | null =>
  r.valueType === 'FIXED' && (r.fixedAmount ?? 0) > 0
    ? r.amountBasis === 'ANNUAL'
      ? (r.fixedAmount as number) / 12
      : (r.fixedAmount as number)
    : null;

export function estimateMonthlyBasic(input: {
  rows: StructureRow[];
  ctcMonthly: number | null;
  lastRunBasics: number[];
}): number | null {
  const basic = input.rows.find((r) => r.componentCode === 'BASIC');
  if (basic) {
    const fixed = monthly(basic);
    if (fixed !== null) return fixed;
    if (basic.valueType === 'PERCENTAGE' && (basic.percentageValue ?? 0) > 0) {
      const of = (basic.percentageOf ?? '').toUpperCase();
      const pct = (basic.percentageValue as number) / 100;
      if (of === 'CTC' && (input.ctcMonthly ?? 0) > 0) {
        return (input.ctcMonthly as number) * pct;
      }
      const base = input.rows.find((r) => r.componentCode === of);
      const baseAmount = base ? monthly(base) : null;
      if (baseAmount !== null) return baseAmount * pct;
    }
  }
  const fromRuns = input.lastRunBasics.filter((n) => n > 0);
  return fromRuns.length ? Math.max(...fromRuns) : null;
}

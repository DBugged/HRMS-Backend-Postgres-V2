// Purpose: Pure builder/validator for the ESIC monthly contribution upload sheet (the portal's "MC template").
// Columns, in order: IP Number | IP Name | No. of days wages paid/payable | Total monthly wages |
//   Reason code for zero working days | Last working day (DD/MM/YYYY).
// Important: Built from the published MC template instructions. The ESIC portal's own upload validation is the final
//   authority — it has historically asked for the sheet saved as Excel 97-2003 (.xls); if it refuses the .xlsx, open
//   the file and use Save As.

export const ESIC_HEADERS = [
  'IP Number\n( 10 Digits )',
  'IP Name\n( Only alphabets and space )',
  'No of Days for which wages paid/payable during the month',
  'Total Monthly Wages',
  'Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reasons)',
  'Last Working Day\n( Format DD/MM/YYYY or DD-MM-YYYY)',
] as const;

// Reason codes used on the template (0 = wages were paid for at least one day).
export const ESIC_REASON = {
  WITH_WAGES: 0,
  WITHOUT_WAGES: 1,
  ON_LEAVE: 2,
  LEFT_SERVICE: 3,
} as const;

export interface EsicMemberInput {
  ipNumber: string;
  name: string;
  // Days of wages paid/payable (may be fractional — the portal wants a whole number, rounded UP).
  payableDays: number;
  // ESI wages for the month.
  wages: number;
  unpaidLeaveDays: number;
  // YYYY-MM-DD when the employee left service in this month (or earlier with no wages).
  lastWorkingDay: string | null;
}

export interface EsicIssue {
  ipNumber: string;
  name: string;
  level: 'error' | 'warning';
  message: string;
}

export interface EsicRow {
  ipNumber: string;
  name: string;
  days: number;
  wages: number;
  reasonCode: number;
  lastWorkingDay: string;
}

export function esicName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const toDmy = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

export function buildEsicRows(
  members: EsicMemberInput[],
  opts: { daysInMonth: number; month: number; year: number },
): {
  rows: EsicRow[];
  issues: EsicIssue[];
  skipped: EsicIssue[];
  totals: { members: number; wages: number };
} {
  const rows: EsicRow[] = [];
  const issues: EsicIssue[] = [];
  const skipped: EsicIssue[] = [];
  const seen = new Set<string>();
  const monthPrefix = `${opts.year}-${String(opts.month).padStart(2, '0')}`;

  for (const m of members) {
    const ip = (m.ipNumber ?? '').trim();
    const name = esicName(m.name ?? '');
    const at = { ipNumber: ip || '-', name: m.name };
    const errs: string[] = [];
    if (!/^\d{10}$/.test(ip))
      errs.push(
        ip ? `ESIC number "${ip}" is not 10 digits` : 'no ESIC number recorded',
      );
    else if (seen.has(ip))
      errs.push('the same ESIC number appears for another employee');
    if (!name) errs.push('name has no usable letters');

    const days = Math.min(
      opts.daysInMonth,
      Math.max(0, Math.ceil(m.payableDays - 1e-9)),
    );
    const wages = days > 0 ? Math.round(m.wages) : 0;
    const leftThisMonth =
      !!m.lastWorkingDay && m.lastWorkingDay.startsWith(monthPrefix);
    const leftEarlier =
      !!m.lastWorkingDay && m.lastWorkingDay < `${monthPrefix}-01`;

    let reason: number = ESIC_REASON.WITH_WAGES;
    if (days === 0) {
      if (m.lastWorkingDay) reason = ESIC_REASON.LEFT_SERVICE;
      else if (m.unpaidLeaveDays >= opts.daysInMonth)
        reason = ESIC_REASON.ON_LEAVE;
      else reason = ESIC_REASON.WITHOUT_WAGES;
    }
    if (reason === ESIC_REASON.LEFT_SERVICE && !m.lastWorkingDay) {
      errs.push('left service but no last working day recorded');
    }
    if (leftEarlier && days > 0)
      issues.push({
        ...at,
        level: 'warning',
        message: 'Wages in a month after the recorded last working day.',
      });
    if (days > 0 && wages === 0)
      issues.push({
        ...at,
        level: 'warning',
        message: 'Days of wages but zero wages.',
      });

    if (errs.length) {
      const e: EsicIssue = { ...at, level: 'error', message: errs.join('; ') };
      issues.push(e);
      skipped.push(e);
      continue;
    }
    seen.add(ip);
    rows.push({
      ipNumber: ip,
      name,
      days,
      wages,
      reasonCode: reason,
      // Shown for anyone who left service (with or without wages in the month of leaving).
      lastWorkingDay:
        m.lastWorkingDay && (leftThisMonth || days === 0)
          ? toDmy(m.lastWorkingDay)
          : '',
    });
  }
  return {
    rows,
    issues,
    skipped,
    totals: {
      members: rows.length,
      wages: rows.reduce((s, r) => s + r.wages, 0),
    },
  };
}

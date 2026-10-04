// Purpose: Pure builder/validator for the EPFO ECR 2.0 text file (Electronic Challan cum Return) used to upload the
//   monthly PF contributions.
// Format (one line per member, no header, fields separated by "#~#", all amounts whole rupees):
//   UAN#~#MEMBER NAME#~#GROSS WAGES#~#EPF WAGES#~#EPS WAGES#~#EDLI WAGES#~#EPF CONTRI#~#EPS CONTRI#~#EPF-EPS DIFF#~#NCP DAYS#~#REFUND OF ADVANCES
// Important: Built from published descriptions of the ECR 2.0 layout; the EPFO portal's own upload validation is the
//   final authority, so run the file through it before paying the challan.

export const ECR_SEPARATOR = '#~#';

export interface EcrMemberInput {
  uan: string;
  name: string;
  grossWages: number;
  // PF wages already capped at the PF wage ceiling by payroll.
  epfWages: number;
  // Employee's EPF share actually deducted.
  epfContribution: number;
  // Employer's EPS share (8.33% of EPS wages).
  epsContribution: number;
  // Employer's EPF-EPS difference share.
  employerEpfShare: number;
  ncpDays: number;
  refundOfAdvances?: number;
}

export interface EcrIssue {
  uan: string;
  name: string;
  level: 'error' | 'warning';
  message: string;
}

export interface EcrResult {
  lines: string[];
  issues: EcrIssue[];
  totals: {
    members: number;
    grossWages: number;
    epfWages: number;
    epsWages: number;
    edliWages: number;
    epfContribution: number;
    epsContribution: number;
    epfEpsDiff: number;
    ncpDays: number;
  };
  // Members left out because an error stops the portal from accepting them.
  skipped: EcrIssue[];
}

// The portal accepts letters, spaces and "." in names only.
export function ecrName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const rupees = (n: number) => Math.round(n);

export function buildEcr(
  members: EcrMemberInput[],
  opts: { wageCeiling: number; daysInMonth: number },
): EcrResult {
  const issues: EcrIssue[] = [];
  const skipped: EcrIssue[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const totals = {
    members: 0,
    grossWages: 0,
    epfWages: 0,
    epsWages: 0,
    edliWages: 0,
    epfContribution: 0,
    epsContribution: 0,
    epfEpsDiff: 0,
    ncpDays: 0,
  };

  for (const m of members) {
    const uan = (m.uan ?? '').trim();
    const name = ecrName(m.name ?? '');
    const at = { uan: uan || '-', name: m.name };
    const hardErrors: string[] = [];
    if (!/^\d{12}$/.test(uan))
      hardErrors.push(
        uan ? `UAN "${uan}" is not 12 digits` : 'no UAN recorded',
      );
    else if (seen.has(uan))
      hardErrors.push('the same UAN appears for another employee');
    if (!name) hardErrors.push('name has no usable letters');

    const gross = rupees(m.grossWages);
    const epfWages = Math.min(rupees(m.epfWages), gross);
    const epsWages = Math.min(epfWages, opts.wageCeiling);
    const edliWages = Math.min(epfWages, opts.wageCeiling);
    const epf = rupees(m.epfContribution);
    const eps = Math.min(rupees(m.epsContribution), epf);
    const diff = epf - eps;
    const ncp = Math.max(0, Math.min(opts.daysInMonth, Math.round(m.ncpDays)));

    if (rupees(m.epfWages) > gross)
      issues.push({
        ...at,
        level: 'warning',
        message: 'EPF wages exceeded gross wages and were capped at gross.',
      });
    if (epfWages > 0 && Math.abs(epf - Math.round(epfWages * 0.12)) > 1)
      issues.push({
        ...at,
        level: 'warning',
        message: `EPF contribution ${epf} is not 12% of EPF wages ${epfWages} — the portal checks this.`,
      });
    if (epsWages > 0 && Math.abs(eps - Math.round(epsWages * 0.0833)) > 1)
      issues.push({
        ...at,
        level: 'warning',
        message: `EPS contribution ${eps} is not 8.33% of EPS wages ${epsWages} — the portal checks this.`,
      });
    if (rupees(m.employerEpfShare) !== diff)
      issues.push({
        ...at,
        level: 'warning',
        message: `Employer EPF share ${rupees(m.employerEpfShare)} differs from EPF - EPS (${diff}); the file uses ${diff}.`,
      });
    if (gross === 0 && ncp < opts.daysInMonth)
      issues.push({
        ...at,
        level: 'warning',
        message: 'No wages but NCP days are less than the days in the month.',
      });

    if (hardErrors.length) {
      const e: EcrIssue = {
        ...at,
        level: 'error',
        message: hardErrors.join('; '),
      };
      issues.push(e);
      skipped.push(e);
      continue;
    }
    seen.add(uan);
    lines.push(
      [
        uan,
        name,
        gross,
        epfWages,
        epsWages,
        edliWages,
        epf,
        eps,
        diff,
        ncp,
        rupees(m.refundOfAdvances ?? 0),
      ].join(ECR_SEPARATOR),
    );
    totals.members += 1;
    totals.grossWages += gross;
    totals.epfWages += epfWages;
    totals.epsWages += epsWages;
    totals.edliWages += edliWages;
    totals.epfContribution += epf;
    totals.epsContribution += eps;
    totals.epfEpsDiff += diff;
    totals.ncpDays += ncp;
  }
  return { lines, issues, totals, skipped };
}

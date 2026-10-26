// Purpose: the letters and emails the system sends by itself, and the rule for spotting one that cannot go out.
// Responsibilities: lists what each automation needs (so the list lives in one place) and finds the gaps: a letter template
//   that is missing or switched off, or an email template switched off.
// Important: pure, no database. A missing EMAIL template is not a gap - the built-in wording is used - only a switched-off one is.
//   A missing or switched-off LETTER template is a gap: the letter is silently skipped.
export interface AutomationTemplate {
  kind: 'letter' | 'email';
  key: string;
  label: string;
  // What triggers it, in the words HR reads.
  usedFor: string;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  { kind: 'letter', key: 'resignationAcceptance', label: 'Resignation acceptance letter', usedFor: 'Emailed when a resignation is approved' },
  { kind: 'letter', key: 'confirmationLetter', label: 'Confirmation letter', usedFor: 'Emailed when probation is confirmed' },
  { kind: 'letter', key: 'probationExtensionLetter', label: 'Probation extension letter', usedFor: 'Emailed when probation is extended' },
  { kind: 'letter', key: 'relievingLetter', label: 'Relieving letter', usedFor: 'Emailed when an exit is completed' },
  { kind: 'letter', key: 'experienceCertificate', label: 'Experience certificate', usedFor: 'Emailed when an exit is completed' },
  { kind: 'email', key: 'EXIT_DOCUMENTS_PACK', label: 'Exit documents pack email', usedFor: 'Last payslips emailed the morning after the last working day' },
  { kind: 'email', key: 'EXIT_COMPLETED', label: 'Exit completed email', usedFor: 'Sent when an exit is completed' },
  { kind: 'email', key: 'PROBATION_ENDING', label: 'Probation ending email', usedFor: 'Reminds managers and HR before probation ends' },
];

export interface TemplateGap extends AutomationTemplate {
  problem: 'MISSING' | 'OFF';
}

export function findTemplateGaps(
  letters: { key: string; isActive: boolean }[],
  emails: { occasionKey: string; isActive: boolean }[],
  required: AutomationTemplate[] = AUTOMATION_TEMPLATES,
): TemplateGap[] {
  const gaps: TemplateGap[] = [];
  for (const r of required) {
    if (r.kind === 'letter') {
      const row = letters.find((l) => l.key === r.key);
      if (!row) gaps.push({ ...r, problem: 'MISSING' });
      else if (!row.isActive) gaps.push({ ...r, problem: 'OFF' });
    } else {
      const row = emails.find((e) => e.occasionKey === r.key);
      if (row && !row.isActive) gaps.push({ ...r, problem: 'OFF' });
    }
  }
  return gaps;
}

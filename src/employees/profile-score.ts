// Purpose: how complete an employee's profile is, as a percentage and a list of what is still missing - so HR sees gaps (a bank
//   account, a personal email) before payroll or an exit needs them, instead of finding out at that moment.
// Responsibilities: pure scoring over the personal data, the personal email and the mandatory-document requirements; no database.
// Important: the personal fields are the same list that decides profileCompleted (REQUIRED_FOR_COMPLETION in personal-data.ts) plus the
//   personal email (where the final documents go after an exit) and the PAN (needed for tax); a mandatory document counts once an
//   upload exists that is not rejected. "payrollReady" is stricter and narrower: bank details and PAN only.
export interface MissingItem {
  key: string;
  label: string;
  group: 'Personal' | 'Family' | 'Emergency' | 'Experience' | 'Bank & tax' | 'Documents' | 'Contact';
}

export interface ProfileScore {
  percent: number;
  total: number;
  filled: number;
  missing: MissingItem[];
  // Bank account (holder, bank, number, IFSC) and PAN all present: the minimum for paying salary and deducting tax correctly.
  payrollReady: boolean;
}

type Field = MissingItem & { payroll?: boolean };

const FIELDS: Field[] = [
  { key: 'fullNameAsPerGovtId', label: 'Full name (as per government ID)', group: 'Personal' },
  { key: 'dateOfBirth', label: 'Date of birth', group: 'Personal' },
  { key: 'gender', label: 'Gender', group: 'Personal' },
  { key: 'maritalStatus', label: 'Marital status', group: 'Personal' },
  { key: 'bloodGroup', label: 'Blood group', group: 'Personal' },
  { key: 'currentAddress', label: 'Current address', group: 'Personal' },
  { key: 'personalEmail', label: 'Personal email', group: 'Contact' },
  { key: 'fatherName', label: "Father's name", group: 'Family' },
  { key: 'fatherContact', label: "Father's contact", group: 'Family' },
  { key: 'motherName', label: "Mother's name", group: 'Family' },
  { key: 'motherContact', label: "Mother's contact", group: 'Family' },
  { key: 'emergencyContact1Name', label: 'Emergency contact 1 name', group: 'Emergency' },
  { key: 'emergencyContact1Number', label: 'Emergency contact 1 number', group: 'Emergency' },
  { key: 'emergencyContact2Name', label: 'Emergency contact 2 name', group: 'Emergency' },
  { key: 'emergencyContact2Number', label: 'Emergency contact 2 number', group: 'Emergency' },
  { key: 'totalExperience', label: 'Total experience', group: 'Experience' },
  { key: 'currentOrganization', label: 'Last organization', group: 'Experience' },
  { key: 'relevantExperience', label: 'Relevant experience', group: 'Experience' },
  { key: 'bankAccountHolderName', label: 'Bank account holder name', group: 'Bank & tax', payroll: true },
  { key: 'bankName', label: 'Bank name', group: 'Bank & tax', payroll: true },
  { key: 'bankAccountNo', label: 'Bank account number', group: 'Bank & tax', payroll: true },
  { key: 'bankIFSC', label: 'Bank IFSC', group: 'Bank & tax', payroll: true },
  { key: 'panNumber', label: 'PAN', group: 'Bank & tax', payroll: true },
];

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function profileScore(
  personalData: Record<string, unknown> | null | undefined,
  requirements: { name: string; isMandatory: boolean; isActive: boolean }[],
  documents: { docType: string; status: string }[],
): ProfileScore {
  const pd = personalData ?? {};
  const missing: MissingItem[] = [];
  let payrollReady = true;
  for (const f of FIELDS) {
    if (filled(pd[f.key])) continue;
    missing.push({ key: f.key, label: f.label, group: f.group });
    if (f.payroll) payrollReady = false;
  }
  const mandatory = requirements.filter((r) => r.isMandatory && r.isActive);
  for (const r of mandatory) {
    if (!documents.some((d) => d.docType === r.name && d.status !== 'REJECTED')) {
      missing.push({ key: `doc:${r.name}`, label: `${r.name} (document)`, group: 'Documents' });
    }
  }
  const total = FIELDS.length + mandatory.length;
  const done = total - missing.length;
  return { percent: total === 0 ? 100 : Math.round((done / total) * 100), total, filled: done, missing, payrollReady };
}

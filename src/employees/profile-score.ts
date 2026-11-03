// Purpose: how complete an employee's profile is, as a percentage and a list of what is still missing - so HR sees gaps (a bank
//   account, a personal email) before payroll or an exit needs them, instead of finding out at that moment.
// Responsibilities: pure scoring over the personal data, the personal email and the mandatory-document requirements; no database.
// Important: the personal fields are the same list that decides profileCompleted (REQUIRED_FOR_COMPLETION in personal-data.ts) plus the
//   personal email (where the final documents go after an exit) and the PAN (needed for tax); a mandatory document counts once an
//   upload exists that is not rejected. "payrollReady" is stricter and narrower: bank details and PAN only.
import { isPlaceholderEmail } from '../common/no-email';

export interface MissingItem {
  key: string;
  label: string;
  group: 'Personal' | 'Family' | 'Emergency' | 'Experience' | 'Bank & tax' | 'Documents' | 'Contact' | 'Job';
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
  { key: 'fullNameAsPerGovtId', label: 'Full name (as per Govt ID)', group: 'Personal' },
  { key: 'dateOfBirth', label: 'Date of birth', group: 'Personal' },
  { key: 'gender', label: 'Gender', group: 'Personal' },
  { key: 'maritalStatus', label: 'Marital status', group: 'Personal' },
  { key: 'bloodGroup', label: 'Blood group', group: 'Personal' },
  { key: 'currentAddress', label: 'Current address', group: 'Personal' },
  { key: 'personalEmail', label: 'Personal email', group: 'Contact' },
  // Kept on the employee record rather than the personal data; withAccountFields() brings them in. All are asked for when an
  // employee is added, so a gap here is an imported or older record.
  { key: 'contactNumber', label: 'Contact number', group: 'Contact' },
  { key: 'profileImage', label: 'Profile photo', group: 'Personal' },
  { key: 'designation', label: 'Designation', group: 'Job' },
  { key: 'departmentId', label: 'Department', group: 'Job' },
  { key: 'employeeCategory', label: 'Employee category', group: 'Job' },
  { key: 'workLocationId', label: 'Work location', group: 'Job' },
  { key: 'fatherName', label: "Father's name", group: 'Family' },
  { key: 'fatherContact', label: "Father's contact", group: 'Family' },
  { key: 'motherName', label: "Mother's name", group: 'Family' },
  { key: 'motherContact', label: "Mother's contact", group: 'Family' },
  { key: 'emergencyContact1Name', label: 'Emergency contact 1 - name', group: 'Emergency' },
  { key: 'emergencyContact1Number', label: 'Emergency contact 1 - number', group: 'Emergency' },
  { key: 'emergencyContact2Name', label: 'Emergency contact 2 - name', group: 'Emergency' },
  { key: 'emergencyContact2Number', label: 'Emergency contact 2 - number', group: 'Emergency' },
  { key: 'totalExperience', label: 'Total experience', group: 'Experience' },
  { key: 'currentOrganization', label: 'Last organization', group: 'Experience' },
  { key: 'relevantExperience', label: 'Relevant experience / skills summary', group: 'Experience' },
  { key: 'bankAccountHolderName', label: 'Bank account holder name', group: 'Bank & tax', payroll: true },
  { key: 'bankName', label: 'Bank name', group: 'Bank & tax', payroll: true },
  { key: 'bankAccountNo', label: 'Bank account number', group: 'Bank & tax', payroll: true },
  { key: 'bankIFSC', label: 'Bank IFSC code', group: 'Bank & tax', payroll: true },
  { key: 'panNumber', label: 'PAN card number', group: 'Bank & tax', payroll: true },
  { key: 'aadharNumber', label: 'Aadhaar card number', group: 'Bank & tax' },
  { key: 'cancelledChequeUrl', label: 'Cancelled cheque', group: 'Bank & tax' },
];

// Gender is saved as an enum on the employee record by the Add / Edit Employee and Account Details forms, and as a label in the
// personal data by My Profile. Either one counts, so setting it in one place never leaves it "missing" here.
const GENDER_LABEL: Record<string, string> = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other', PREFER_NOT_TO_SAY: 'Prefer not to say' };
export function withRootGender(
  personalData: Record<string, unknown> | null | undefined,
  gender: string | null | undefined,
): Record<string, unknown> {
  const pd = personalData ?? {};
  const has = typeof pd.gender === 'string' && pd.gender.trim().length > 0;
  return has || !gender ? pd : { ...pd, gender: GENDER_LABEL[gender] ?? gender };
}

export function withAccountFields(
  personalData: Record<string, unknown> | null | undefined,
  employee: {
    contactNumber?: string | null;
    profileImage?: string | null;
    designation?: string | null;
    departmentId?: string | null;
    employeeCategory?: string | null;
    workLocationId?: string | null;
    // The login address: a placeholder means the person has no email, so a personal email is not expected of them.
    email?: string | null;
  },
): Record<string, unknown> {
  const pd = personalData ?? {};
  return {
    ...pd,
    ...(isPlaceholderEmail(employee.email) && !pd.personalEmail ? { personalEmail: 'none (no email)' } : {}),
    contactNumber: employee.contactNumber ?? '',
    profileImage: employee.profileImage ?? '',
    designation: employee.designation ?? '',
    departmentId: employee.departmentId ?? '',
    employeeCategory: employee.employeeCategory ?? '',
    workLocationId: employee.workLocationId ?? '',
  };
}

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function profileScore(
  personalData: Record<string, unknown> | null | undefined,
  requirements: { name: string; isMandatory: boolean; isActive: boolean }[],
  documents: { docType: string; status: string }[],
  // A UAN is asked for where PF applies, unless the person said they have none yet (their first PF job).
  opts: { uanRequired?: boolean } = {},
): ProfileScore {
  const pd = personalData ?? {};
  const missing: MissingItem[] = [];
  let payrollReady = true;
  for (const f of FIELDS) {
    if (filled(pd[f.key])) continue;
    missing.push({ key: f.key, label: f.label, group: f.group });
    if (f.payroll) payrollReady = false;
  }
  let extra = 0;
  if (opts.uanRequired && pd.noUanYet !== true) {
    extra = 1;
    if (!filled(pd.uanNumber)) missing.push({ key: 'uanNumber', label: 'UAN number', group: 'Bank & tax' });
  }
  const mandatory = requirements.filter((r) => r.isMandatory && r.isActive);
  for (const r of mandatory) {
    if (!documents.some((d) => d.docType === r.name && d.status !== 'REJECTED')) {
      missing.push({ key: `doc:${r.name}`, label: `${r.name} (document)`, group: 'Documents' });
    }
  }
  const total = FIELDS.length + extra + mandatory.length;
  const done = total - missing.length;
  return { percent: total === 0 ? 100 : Math.round((done / total) * 100), total, filled: done, missing, payrollReady };
}

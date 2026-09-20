// Purpose: Default (starter) content for a new organization's privacy settings, notice and processor register.
// Responsibilities: Builds processing purposes, data categories, retention rules, the draft privacy notice v1 and
// the system-detected processor list — every item derived from data the HRMS demonstrably handles today.
// Important: These are TEMPLATES for the org's privacy officer and legal counsel to review, not legal advice.
// Retention periods are SUGGESTED conventions only (see SUGGESTED_RETENTION) — never auto-delete (ARCHIVE / MANUAL_REVIEW
// only), always legalReviewRequired. Legal bases are
// sensible starting points flagged legalReviewRequired where the choice is genuinely debatable (e.g. selfie/GPS
// capture, which is currently mandatory on every punch with no consent step).

export type LegalBasis =
  'LEGAL_OBLIGATION' | 'CONTRACT' | 'LEGITIMATE_USE' | 'CONSENT';
export const LEGAL_BASES: LegalBasis[] = [
  'LEGAL_OBLIGATION',
  'CONTRACT',
  'LEGITIMATE_USE',
  'CONSENT',
];
export const RETENTION_ACTIONS = [
  'ARCHIVE',
  'ANONYMIZE',
  'DELETE',
  'MANUAL_REVIEW',
] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export interface ProcessingPurpose {
  key: string;
  label: string;
  description: string;
  legalBasis: LegalBasis;
  modules: string[];
  legalReviewRequired?: boolean;
  notes?: string;
  withdrawalConsequence?: string;
}

export interface DataCategoryField {
  key: string;
  label: string;
  source: string;
}
export interface DataCategory {
  key: string;
  label: string;
  fields: DataCategoryField[];
}

export interface RetentionRule {
  dataType: string;
  label: string;
  periodMonths: number | null;
  basis: string;
  action: RetentionAction;
  legalReviewRequired: boolean;
}

export const NOTICE_TEMPLATE_DISCLAIMER =
  'TEMPLATE - requires review by your legal counsel before publishing. It describes what this HRMS actually collects, but it is not legal advice and does not by itself make any organization compliant with any law.';

export function defaultPurposes(): ProcessingPurpose[] {
  return [
    {
      key: 'onboarding',
      label: 'Onboarding and employment records',
      description:
        'Creating your employee account and profile, keeping your employment details and the documents you submit at joining.',
      legalBasis: 'CONTRACT',
      modules: ['employees', 'documents', 'employee-timeline'],
    },
    {
      key: 'payroll',
      label: 'Payroll and salary payment',
      description:
        'Calculating and paying salary, generating payslips, tax declarations and reimbursements.',
      legalBasis: 'CONTRACT',
      modules: ['payroll', 'tax-declarations', 'reimbursements'],
    },
    {
      key: 'attendance',
      label: 'Attendance and working time',
      description:
        'Recording punches, attendance status and overtime. Punches can include a selfie and GPS location.',
      legalBasis: 'LEGITIMATE_USE',
      modules: ['attendance', 'overtime'],
      legalReviewRequired: true,
      notes:
        'Selfie and GPS capture is currently mandatory on every punch, with no notice or consent step in the apps. Confirm the lawful basis (and whether these should be optional) with legal counsel.',
    },
    {
      key: 'leave',
      label: 'Leave management',
      description:
        'Leave requests, balances, comp-offs and leave encashment, including any medical certificate you attach.',
      legalBasis: 'CONTRACT',
      modules: ['leaves', 'leave-balances', 'comp-offs', 'leave-encashments'],
    },
    {
      key: 'statutory_compliance',
      label: 'Statutory compliance',
      description:
        'Provident fund, ESI, professional tax, income tax and similar statutory calculations and reports that the employer must maintain.',
      legalBasis: 'LEGAL_OBLIGATION',
      modules: ['payroll', 'statutory-config', 'reports'],
    },
    {
      key: 'communication',
      label: 'Operational communication',
      description:
        'System emails and in-app notifications about your requests, approvals, payslips, letters and account (for example password reset).',
      legalBasis: 'LEGITIMATE_USE',
      modules: ['notifications', 'email-templates', 'letters'],
    },
    {
      key: 'optional_communications',
      label: 'Optional announcements and celebrations',
      description:
        'HR broadcast announcements by email and celebration messages such as birthday or work-anniversary wishes.',
      legalBasis: 'CONSENT',
      modules: ['notifications', 'hr-events'],
      legalReviewRequired: true,
      notes:
        'Consent withdrawal is recorded here; applying it to notification preferences and the wishes job is a follow-up.',
      withdrawalConsequence:
        'You will stop receiving optional announcements and celebration messages once HR applies your choice. Operational emails about your own requests, payslips and account continue, because they are needed to run your employment.',
    },
    {
      key: 'benefits_loans',
      label: 'Loans, benefits and offboarding settlement',
      description:
        'Employee loans and repayments, final settlement and offboarding records.',
      legalBasis: 'CONTRACT',
      modules: ['loans', 'settlements', 'offboarding'],
    },
    {
      key: 'asset_management',
      label: 'Company asset management',
      description: 'Tracking company assets allocated to you.',
      legalBasis: 'LEGITIMATE_USE',
      modules: ['employees'],
    },
    {
      key: 'security_access',
      label: 'Security and access control',
      description:
        'Login, sessions, account lockout, role-based access and audit trails that protect employee data.',
      legalBasis: 'LEGITIMATE_USE',
      modules: ['auth', 'audit-log', 'privacy'],
    },
  ];
}

const f = (key: string, label: string, source: string): DataCategoryField => ({
  key,
  label,
  source,
});

// Every field below maps to a column or personalData key that exists today (see the data inventory).
export function defaultCategories(): DataCategory[] {
  return [
    {
      key: 'identity_contact',
      label: 'Identity and contact',
      fields: [
        f('name', 'Name', 'users.name'),
        f('email', 'Login email', 'users.email'),
        f('officialEmail', 'Official email', 'users.officialEmail'),
        f('contactNumber', 'Contact number', 'users.contactNumber'),
        f('gender', 'Gender', 'users.gender'),
        f('profileImage', 'Profile photo', 'users.profileImage'),
        f(
          'fullNameAsPerGovtId',
          'Full name as per government ID',
          'users.personalData.fullNameAsPerGovtId',
        ),
        f('dateOfBirth', 'Date of birth', 'users.personalData.dateOfBirth'),
        f(
          'maritalStatus',
          'Marital status',
          'users.personalData.maritalStatus',
        ),
        f('bloodGroup', 'Blood group', 'users.personalData.bloodGroup'),
        f(
          'personalEmail',
          'Personal email',
          'users.personalData.personalEmail',
        ),
        f(
          'currentAddress',
          'Current address',
          'users.personalData.currentAddress',
        ),
      ],
    },
    {
      key: 'family_emergency',
      label: 'Family and emergency contacts',
      fields: [
        f(
          'fatherName',
          'Father name and contact',
          'users.personalData.fatherName',
        ),
        f(
          'motherName',
          'Mother name and contact',
          'users.personalData.motherName',
        ),
        f(
          'emergencyContact1',
          'Emergency contact 1',
          'users.personalData.emergencyContact1Name',
        ),
        f(
          'emergencyContact2',
          'Emergency contact 2',
          'users.personalData.emergencyContact2Name',
        ),
      ],
    },
    {
      key: 'employment',
      label: 'Employment details',
      fields: [
        f('employeeId', 'Employee ID', 'users.employeeId'),
        f('designation', 'Designation', 'users.designation'),
        f('department', 'Department', 'users.departmentId'),
        f('joiningDate', 'Joining date', 'users.joiningDate'),
        f('employmentStatus', 'Employment status', 'users.employmentStatus'),
        f('reportingManager', 'Reporting manager', 'users.reportingManagerId'),
        f(
          'previousEmployment',
          'Previous employment',
          'users.personalData.previousEmployment',
        ),
        f(
          'timeline',
          'Employment timeline and role history',
          'employee_timelines',
        ),
      ],
    },
    {
      key: 'statutory_ids',
      label: 'Government and statutory identifiers',
      fields: [
        f('panNumber', 'PAN', 'users.personalData.panNumber'),
        f('aadharNumber', 'Aadhaar number', 'users.personalData.aadharNumber'),
        f('uanNumber', 'UAN', 'users.personalData.uanNumber'),
        f('esicNumber', 'ESIC number', 'users.personalData.esicNumber'),
      ],
    },
    {
      key: 'bank',
      label: 'Bank details',
      fields: [
        f(
          'bankAccountNo',
          'Bank account number',
          'users.personalData.bankAccountNo',
        ),
        f('bankIFSC', 'IFSC', 'users.personalData.bankIFSC'),
        f('bankName', 'Bank name', 'users.personalData.bankName'),
        f(
          'bankAccountHolderName',
          'Account holder name',
          'users.personalData.bankAccountHolderName',
        ),
        f(
          'cancelledCheque',
          'Cancelled cheque file',
          'users.personalData.cancelledChequeUrl',
        ),
      ],
    },
    {
      key: 'documents',
      label: 'Documents you submit',
      fields: [
        f(
          'docType',
          'Document type and file name',
          'employee_documents.docType',
        ),
        f('file', 'Document file', 'employee_documents.fileUrl'),
        f(
          'reviewStatus',
          'Review status and reason',
          'employee_documents.status',
        ),
      ],
    },
    {
      key: 'attendance_location',
      label: 'Attendance, location and selfie',
      fields: [
        f('punchTime', 'Punch time', 'punches.punchTime'),
        f(
          'gps',
          'GPS latitude/longitude and location text',
          'punches.latitude',
        ),
        f('selfie', 'Punch selfie', 'punches.selfieUrl'),
        f('attendanceStatus', 'Daily attendance status', 'attendances.status'),
        f('overtime', 'Overtime records', 'overtime_records'),
      ],
    },
    {
      key: 'leave',
      label: 'Leave',
      fields: [
        f('leaveRequests', 'Leave requests and remarks', 'leaves'),
        f(
          'leaveAttachment',
          'Leave attachment (e.g. medical certificate)',
          'leaves.attachmentUrl',
        ),
        f('leaveBalance', 'Leave balances', 'leave_balances'),
      ],
    },
    {
      key: 'payroll',
      label: 'Payroll and tax',
      fields: [
        f(
          'salaryComponents',
          'Salary components',
          'employee_salary_components',
        ),
        f(
          'payslips',
          'Payslips, earnings, deductions, net pay',
          'payroll_runs',
        ),
        f('taxDeclaration', 'Tax declaration', 'employee_tax_declarations'),
        f('reimbursements', 'Reimbursements and receipts', 'reimbursements'),
      ],
    },
    {
      key: 'loans_settlement',
      label: 'Loans and settlement',
      fields: [
        f('loans', 'Loans and repayments', 'loans'),
        f('settlement', 'Final settlement', 'settlements'),
        f(
          'offboarding',
          'Offboarding case and exit interview',
          'offboarding_cases',
        ),
      ],
    },
    {
      key: 'assets',
      label: 'Assets',
      fields: [f('assets', 'Allocated company assets', 'employee_assets')],
    },
    {
      key: 'system_security',
      label: 'Account and security',
      fields: [
        f('passwordHash', 'Password (stored hashed)', 'users.password'),
        f('loginHistory', 'Last login and lockout state', 'users.lastLoginAt'),
        f('sessions', 'Refresh sessions (IP and browser)', 'refresh_tokens'),
        f('notifications', 'In-app notifications', 'notifications'),
        f(
          'notificationPreferences',
          'Notification preferences',
          'users.notificationPreferences',
        ),
        f('auditLog', 'Audit log entries about your account', 'audit_logs'),
      ],
    },
  ];
}

const RULE_LABELS: Array<[string, string]> = [
  ['employee_profile', 'Employee profile after separation'],
  ['payroll_records', 'Payroll, payslip and tax records'],
  ['loan_records', 'Loan and settlement records'],
  ['attendance_records', 'Attendance, punches, GPS and selfies'],
  ['leave_records', 'Leave records'],
  ['documents', 'Employee documents'],
  ['notifications', 'In-app notifications'],
  ['sessions_tokens', 'Expired and revoked login sessions'],
  ['audit_logs', 'Audit log entries'],
  ['privacy_audit_logs', 'Privacy audit log entries'],
];

export const SUGGESTED_RETENTION_BASIS =
  'Suggested default — confirm with legal counsel';

// Common statutory/business conventions (months). Suggestions only; the action is never DELETE.
export const SUGGESTED_RETENTION: Record<
  string,
  { periodMonths: number; action: RetentionAction }
> = {
  employee_profile: { periodMonths: 96, action: 'MANUAL_REVIEW' },
  payroll_records: { periodMonths: 96, action: 'ARCHIVE' },
  loan_records: { periodMonths: 96, action: 'ARCHIVE' },
  attendance_records: { periodMonths: 96, action: 'ARCHIVE' },
  leave_records: { periodMonths: 96, action: 'ARCHIVE' },
  documents: { periodMonths: 96, action: 'MANUAL_REVIEW' },
  notifications: { periodMonths: 12, action: 'ARCHIVE' },
  sessions_tokens: { periodMonths: 12, action: 'ARCHIVE' },
  audit_logs: { periodMonths: 36, action: 'ARCHIVE' },
  privacy_audit_logs: { periodMonths: 36, action: 'ARCHIVE' },
};

export function defaultRetention(): RetentionRule[] {
  return RULE_LABELS.map(([dataType, label]) => {
    const s = SUGGESTED_RETENTION[dataType];
    return {
      dataType,
      label,
      periodMonths: s.periodMonths,
      basis: SUGGESTED_RETENTION_BASIS,
      action: s.action,
      legalReviewRequired: true,
    };
  });
}

export function defaultExportSettings() {
  return {
    downloadLinkTtlSeconds: 600,
    format: 'JSON',
    maskIdentifiers: true,
  };
}

export function defaultDeletionRules() {
  return {
    anonymizeOptionalPersonalData: true,
    removeNonRequiredDocuments: true,
    // Informational: these are never deleted or altered by an erasure request.
    neverModified: [
      'user account',
      'payroll records',
      'loan and settlement records',
      'audit trails',
    ],
  };
}

export function defaultNoticeBody(orgName: string): string {
  return `${NOTICE_TEMPLATE_DISCLAIMER}

PRIVACY NOTICE FOR EMPLOYEES OF ${orgName.toUpperCase()}

1. Why we are giving you this notice
${orgName} uses this HR system to manage your employment. This notice explains, in plain language, what personal data the system holds about you, why, who can see it, how long we keep it and what choices you have.

2. What we collect
- Identity and contact: name, login and official email, contact number, gender, date of birth, marital status, blood group, personal email, current address, profile photo.
- Family and emergency contacts: parents' names and contact details, emergency contacts.
- Employment: employee ID, designation, department, joining date, employment status, reporting manager, previous employment details, role and status history.
- Government and statutory identifiers: PAN, Aadhaar number, UAN and ESIC number.
- Bank details: account holder name, account number, IFSC, bank name and a cancelled cheque image.
- Documents you upload (for example identity, address and education proofs, offer letters) and their review status.
- Attendance: punch times and, when you punch, a selfie and GPS location; daily attendance status and overtime.
- Leave: requests, remarks, balances and any attachment such as a medical certificate.
- Payroll and tax: salary components, payslips, tax declarations, reimbursements with receipts, loans and final settlement.
- Company assets allocated to you.
- Account and security data: hashed password, last login, login sessions (with IP address and browser), in-app notifications, notification preferences and audit-log entries about your account.

3. Why we use it
To run your employment relationship (onboarding, payroll, attendance, leave, loans and offboarding), to meet statutory and legal obligations (for example provident fund, ESI, professional tax and income tax records), to communicate with you about your requests and payslips, to keep company assets in order, and to keep the system secure. Optional announcements and celebration messages are sent only on the basis of your consent, which you can withdraw at any time.

4. Who can see your data
Your HR and administrators can see the data needed for their role. Your reporting manager can see limited information about their team members. You can see your own data. Some data is processed by service providers that keep the system running, such as email delivery and file storage; the list is maintained by your privacy officer.

5. How long we keep it
Suggested retention periods for each type of data are shown in the app and are being confirmed by ${orgName} with legal advice. Data is kept while it is needed for the purposes above and for legal or statutory requirements, and is reviewed by a person before any removal.

6. Your choices and rights
You can ask to access your data, correct or update it, receive a copy, or ask for its erasure, using the privacy section of the app. Some low-risk contact details can be updated quickly. Changes to sensitive fields such as name, date of birth, bank details or PAN follow the normal HR verification process. Erasure may be restricted where the law or your employment records require us to keep data (for example payroll and statutory records); if so, we will tell you why. Where processing relies on your consent, you can withdraw it; withdrawal does not affect processing that the law or your employment contract requires. We aim to respond to requests within the period shown in the app.

7. Contact and complaints
Contact your privacy officer or grievance contact shown in the privacy section of the app.

8. Changes to this notice
When this notice changes, a new version is published and you will be asked to acknowledge it.`;
}

export interface DetectedProcessorInput {
  faceDeviceEnabled: boolean;
}

interface ProcessorSeed {
  name: string;
  service: string;
  dataProcessed: string;
  purpose: string;
  dpaStatus: 'NOT_REQUIRED' | 'PENDING' | 'SIGNED';
  status: 'ACTIVE' | 'INACTIVE';
  notes: string;
}

// Only services the code actually integrates with (see the data inventory, section 9). Status reflects whether the
// deployment's environment currently enables each one.
export function detectedProcessors(
  env: NodeJS.ProcessEnv,
  input: DetectedProcessorInput,
): ProcessorSeed[] {
  const list: ProcessorSeed[] = [];
  const emailDriver = env.EMAIL_DRIVER === 'resend' ? 'resend' : 'smtp';
  list.push({
    name: emailDriver === 'resend' ? 'Resend' : 'SMTP email server',
    service: 'Email delivery',
    dataProcessed:
      'Recipient email, names, message content, payslip and letter PDF attachments, account emails',
    purpose: 'Operational and transactional employee communication',
    dpaStatus: 'PENDING',
    status: 'ACTIVE',
    notes: `Detected driver: ${emailDriver}. Confirm the provider agreement and hosting location.`,
  });
  if (env.FILE_STORAGE_DRIVER === 's3') {
    list.push({
      name: 'AWS S3',
      service: 'File storage',
      dataProcessed:
        'Uploaded documents (identity proofs, cheques), punch selfies, profile photos, generated exports',
      purpose: 'Storage of employee files',
      dpaStatus: 'PENDING',
      status: 'ACTIVE',
      notes: `Region: ${env.AWS_REGION ?? 'not set'}. Confirm agreement and cross-border position.`,
    });
  } else {
    list.push({
      name: 'Local server disk',
      service: 'File storage',
      dataProcessed:
        'Uploaded documents (identity proofs, cheques), punch selfies, profile photos, generated exports',
      purpose: 'Storage of employee files',
      dpaStatus: 'NOT_REQUIRED',
      status: 'ACTIVE',
      notes:
        'Files are stored on the application server (no third-party processor).',
    });
  }
  list.push({
    name: 'Log shipping endpoint',
    service: 'Log shipping',
    dataProcessed:
      'Application log lines (may include request paths and IP addresses)',
    purpose: 'Operational monitoring',
    dpaStatus: 'PENDING',
    status: env.LOG_SHIP_URL ? 'ACTIVE' : 'INACTIVE',
    notes: 'Enabled only when LOG_SHIP_URL is set.',
  });
  list.push({
    name: 'Sentry',
    service: 'Error monitoring',
    dataProcessed: 'Exception data for server errors (5xx)',
    purpose: 'Error diagnosis',
    dpaStatus: 'PENDING',
    status: env.SENTRY_DSN ? 'ACTIVE' : 'INACTIVE',
    notes: 'Enabled only when SENTRY_DSN is set.',
  });
  list.push({
    name: 'Redis',
    service: 'Job queue and rate-limit store',
    dataProcessed:
      'Payslip email job data (employee id, email), throttling counters',
    purpose: 'Background jobs and abuse protection',
    dpaStatus: 'NOT_REQUIRED',
    status: env.REDIS_URL ? 'ACTIVE' : 'INACTIVE',
    notes:
      'Enabled only when REDIS_URL is set; confirm whether it is self-hosted.',
  });
  if (input.faceDeviceEnabled) {
    list.push({
      name: 'Face attendance device vendor',
      service: 'Attendance device webhook (inbound)',
      dataProcessed:
        'Punch time, selfie image, GPS and raw device payload pushed into the HRMS',
      purpose: 'Attendance capture',
      dpaStatus: 'PENDING',
      status: 'ACTIVE',
      notes:
        'Detected because a face API key is configured for this organization.',
    });
  }
  return list;
}

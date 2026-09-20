import {
  EMAIL_PREHEADERS,
  EMAIL_TEMPLATE_DEFAULTS,
} from './email-template-defaults';
import {
  EMAIL_SHELL_MARKER,
  finalizeEmailHtml,
  statusTone,
  wrapEmailShell,
} from './email-layout';
import { renderTemplate } from './render-template';

const branding = {
  companyName: "D'Bugged Programmers",
  phone: '+91-9999999999',
  contactEmail: 'hr@example.com',
  logoImgTag: '',
};

// Every {{placeholder}} a default body/subject/preheader uses must be one of the variables
// its real call site supplies (see the audit in the redesign notes) — anything else would
// render as a literal "{{x}}" in a real email.
const COMMON = ['employeeName', 'companyName'];
const SUPPLIED: Record<string, string[]> = {
  BIRTHDAY: [
    'companyPhone',
    'companyWebsite',
    'companyEmail',
    'companyAddress',
    'companyLogo',
  ],
  NEW_JOINER_ANNOUNCEMENT: [
    'designation',
    'departmentLine',
    'intro',
    'companyPhone',
    'companyWebsite',
    'companyEmail',
    'companyAddress',
    'companyLogo',
  ],
  WORK_ANNIVERSARY: [
    'years',
    'companyPhone',
    'companyWebsite',
    'companyEmail',
    'companyAddress',
    'companyLogo',
  ],
  ABSENT_MARKED: ['date'],
  WFH_DECISION: ['decision', 'date', 'comments'],
  REGULARIZATION_DECISION: ['decision', 'date', 'comments'],
  LEAVE_DECISION: ['decision', 'startDate', 'endDate', 'comments'],
  COMP_OFF_DECISION: ['decision', 'earnedForDate'],
  OVERTIME_STATUS: ['hours', 'date', 'status'],
  LEAVE_ENCASHMENT_STATUS: ['days', 'amount', 'status'],
  LOAN_SANCTIONED: ['loanType', 'principal', 'emiAmount', 'tenureMonths'],
  LOAN_STATUS_UPDATE: ['loanType', 'status', 'reason', 'outstandingBalance'],
  REIMBURSEMENT_STATUS: ['amount', 'category', 'status', 'comments'],
  PAYSLIP_ISSUED: ['month', 'year', 'netPay'],
  TAX_DECLARATION_VERIFIED: ['financialYear'],
  PERFORMANCE_RATING_PUBLISHED: ['financialYear', 'rating'],
  OFFBOARDING_INITIATED: ['lastWorkingDay'],
  SETTLEMENT_PROCESSED: ['netSettlementAmount', 'netSettlementAmountInWords'],
  DOCUMENT_STATUS: ['fileName', 'status', 'reason'],
  WELCOME_EMAIL: ['employeeId', 'email', 'setPasswordUrl', 'loginUrl'],
  LOGIN_CREDENTIALS_RESENT: ['employeeId', 'email', 'setPasswordUrl', 'loginUrl'],
  FOUNDER_ACCOUNT_WELCOME: ['loginUrl'],
  PASSWORD_RESET: ['resetUrl'],
  ACCOUNT_ACTIVATED: ['email'],
  SETUP_COMPLETE: ['loginUrl'],
  LETTER_SENT: ['letterName'],
  PASSWORD_CHANGED: ['changedAt'],
  ROLE_CHANGED: ['previousRole', 'newRole'],
  EXIT_COMPLETED: ['lastWorkingDay'],
  APPROVALS_DIGEST: [
    'totalPending',
    'leaveCount',
    'regularizationCount',
    'wfhCount',
    'compOffCount',
    'overtimeCount',
    'encashmentCount',
    'reimbursementCount',
    'loanCount',
    'reviewUrl',
  ],
};

describe('email layout', () => {
  it('only references variables its call site supplies (subject, body, preheader)', () => {
    for (const t of EMAIL_TEMPLATE_DEFAULTS) {
      const allowed = new Set([...COMMON, ...(SUPPLIED[t.occasionKey] ?? [])]);
      const text = `${t.subject} ${t.bodyHtml} ${EMAIL_PREHEADERS[t.occasionKey] ?? ''}`;
      const used = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
        (m) => m[1],
      );
      const unknown = used.filter((v) => !allowed.has(v));
      expect({ key: t.occasionKey, unknown }).toEqual({
        key: t.occasionKey,
        unknown: [],
      });
    }
  });

  it('every default has a preheader and renders to clean, script-free, wrapped HTML', () => {
    for (const t of EMAIL_TEMPLATE_DEFAULTS) {
      expect(EMAIL_PREHEADERS[t.occasionKey]).toBeTruthy();
      const vars: Record<string, string> = {};
      for (const k of [...COMMON, ...(SUPPLIED[t.occasionKey] ?? [])])
        vars[k] = `v_${k}`;
      const html = wrapEmailShell(
        finalizeEmailHtml(renderTemplate(t.bodyHtml, vars)),
        {
          preheader: renderTemplate(EMAIL_PREHEADERS[t.occasionKey], vars),
          branding,
        },
      );
      expect(html.startsWith(EMAIL_SHELL_MARKER)).toBe(true);
      expect(html).not.toMatch(/\{\{|<script|data-opt|data-status/);
      expect(html).toContain("D'Bugged Programmers");
    }
  });

  it('is idempotent and hides optional blocks that render empty', () => {
    const once = wrapEmailShell('<p>x</p>', { branding });
    expect(wrapEmailShell(once, { branding })).toBe(once);
    const leave = EMAIL_TEMPLATE_DEFAULTS.find(
      (t) => t.occasionKey === 'LEAVE_DECISION',
    )!;
    const base = {
      employeeName: 'A',
      decision: 'APPROVED',
      startDate: 's',
      endDate: 'e',
    };
    const withoutComment = finalizeEmailHtml(
      renderTemplate(leave.bodyHtml, { ...base, comments: '' }),
    );
    const withComment = finalizeEmailHtml(
      renderTemplate(leave.bodyHtml, { ...base, comments: 'Enjoy' }),
    );
    expect(withoutComment).not.toContain('>Comments<');
    expect(withComment).toContain('>Comments<');
    expect(withComment).toContain('Enjoy');
  });

  it('maps status words to the frontend badge tones', () => {
    expect(statusTone('APPROVED')).toBe('success');
    expect(statusTone('REJECTED')).toBe('error');
    expect(statusTone('PENDING')).toBe('warning');
    expect(statusTone('CANCELLED')).toBe('neutral');
  });
});

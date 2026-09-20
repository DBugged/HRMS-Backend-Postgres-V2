// Default occasion-based email templates seeded for every new org, mirroring
// the content HrEventsService used to hardcode inline (see the git history of
// sendBirthdayWish/sendAnniversaryWish before this module existed). Content
// is equivalent, not verbatim — the hardcoded strings had no company
// signature block at all, so one is added here using the
// {{companyName}}/{{companyPhone}}/{{companyWebsite}}/{{companyEmail}}/
// {{companyAddress}} placeholders EmailTemplatesService.render() supports.
import { EmailTemplateCategory } from './email-template-categories';
import {
  button,
  checkList,
  emailBody,
  infoCard,
  mutedText,
  notice,
  optionalNote,
  orderedSteps,
  paragraph,
  statusBadge,
  type CardRow,
} from './email-layout';

export interface EmailTemplateDefault {
  occasionKey: string;
  name: string;
  subject: string;
  bodyHtml: string;
  ccAllActive: boolean;
  // One of EMAIL_TEMPLATE_CATEGORIES — stored on the row (not derived) so a
  // custom template can carry the exact same field. The "// --- Section ---"
  // comments below are just a human map onto this list; category is the
  // actual source of truth read by the frontend's grouped table.
  category: EmailTemplateCategory;
}

// Bodies below are composed from the shared email-layout.ts components (one
// visual system for every email) but remain plain {{placeholder}} strings —
// the same variable names each call site already supplies, rendered by
// renderTemplate() and edited in the Email Templates screen exactly as
// before. The page shell (branded header, footer, hidden preheader) is added
// at send time by EmailTemplatesService, so it is deliberately not stored here.
const greet = paragraph('Hi {{employeeName}},');
const hello = paragraph('Hello {{employeeName}},');
const regards = paragraph('Warm regards,<br/>{{companyName}}');
const row = (
  label: string,
  value: string,
  optionalValue?: string,
): CardRow => ({
  label,
  value,
  ...(optionalValue !== undefined && { optionalValue }),
});
const status = (placeholder: string) => statusBadge(placeholder);

// One-line preview text (the grey snippet next to the subject in an inbox
// list), keyed by occasionKey. Only uses variables that occasion's call site
// already supplies. A custom (org-authored) template has no entry and simply
// gets no preheader.
export const EMAIL_PREHEADERS: Record<string, string> = {
  BIRTHDAY: 'Wishing you a wonderful year ahead, {{employeeName}}.',
  NEW_JOINER_ANNOUNCEMENT: 'Say hello to our newest team member.',
  WORK_ANNIVERSARY:
    'Thank you for everything you have contributed, {{employeeName}}.',
  ABSENT_MARKED: 'You were marked absent for {{date}}.',
  WFH_DECISION: 'Your Work From Home request for {{date}} is {{decision}}.',
  REGULARIZATION_DECISION:
    'Your regularization request for {{date}} is {{decision}}.',
  LEAVE_DECISION:
    'Your leave request for {{startDate}} to {{endDate}} is {{decision}}.',
  COMP_OFF_DECISION:
    'Your comp-off request for {{earnedForDate}} is {{decision}}.',
  OVERTIME_STATUS: 'Your overtime request for {{date}} is {{status}}.',
  LEAVE_ENCASHMENT_STATUS:
    'Your leave encashment request for {{days}} day(s) is {{status}}.',
  LOAN_SANCTIONED:
    'Your {{loanType}} loan of {{principal}} has been sanctioned.',
  LOAN_STATUS_UPDATE: 'Your {{loanType}} loan status is now {{status}}.',
  REIMBURSEMENT_STATUS: 'Your reimbursement claim of {{amount}} is {{status}}.',
  PAYSLIP_ISSUED:
    'Your salary for {{month}}/{{year}} has been paid. Payslip attached.',
  TAX_DECLARATION_VERIFIED:
    'Your tax declaration for FY {{financialYear}} has been verified.',
  PERFORMANCE_RATING_PUBLISHED:
    'Your performance rating for FY {{financialYear}} is now available.',
  OFFBOARDING_INITIATED: 'Your last working day is {{lastWorkingDay}}.',
  SETTLEMENT_PROCESSED: 'Your full & final settlement has been processed.',
  DOCUMENT_STATUS: 'Your document "{{fileName}}" has been {{status}}.',
  WELCOME_EMAIL: 'Your account is ready. Set your password to get started.',
  LOGIN_CREDENTIALS_RESENT: 'Your login details are inside.',
  FOUNDER_ACCOUNT_WELCOME: 'Your organization is set up and ready to go.',
  PASSWORD_RESET:
    'Use the secure link inside to reset your password. It expires in 30 minutes.',
  ACCOUNT_ACTIVATED: 'Your account is now active.',
  SETUP_COMPLETE:
    'Setup for {{companyName}} is complete — the HRMS is ready to use.',
  LETTER_SENT: 'Your {{letterName}} is attached.',
  PASSWORD_CHANGED: 'Your account password was changed on {{changedAt}}.',
  ROLE_CHANGED: 'Your HRMS role changed from {{previousRole}} to {{newRole}}.',
  EXIT_COMPLETED:
    'Your exit process is complete and your HRMS access is closed.',
  APPROVALS_DIGEST: '{{totalPending}} request(s) are waiting for your review.',
};

// Shared shape for the many "your <thing> was <decision>" emails.
function decisionBody(p: {
  category: string;
  title: string;
  message: string;
  rows: CardRow[];
  commentsLabel?: string;
  commentsPlaceholder?: string;
}): string {
  return emailBody({
    category: p.category,
    title: p.title,
    blocks: [
      greet,
      paragraph(p.message),
      infoCard(p.rows),
      ...(p.commentsPlaceholder
        ? [optionalNote(p.commentsLabel ?? 'Comments', p.commentsPlaceholder)]
        : []),
    ],
  });
}

const CREDENTIALS_BODY = emailBody({
  category: 'Account & Access',
  title: 'Your login details',
  blocks: [
    hello,
    paragraph(
      'Your account on {{companyName}} HRMS is ready. Use the button below to set your password.',
    ),
    infoCard([
      row('Employee ID', '{{employeeId}}'),
      row('Email', '{{email}}'),
      row(
        'Login URL',
        '<a href="{{loginUrl}}" style="color:#5546e0;text-decoration:underline;">{{loginUrl}}</a>',
      ),
    ]),
    button('{{setPasswordUrl}}', 'Set your password'),
    notice(
      'This link works once and expires in 7 days. Your password is never sent by email.',
      'warning',
    ),
  ],
});

export const EMAIL_TEMPLATE_DEFAULTS: EmailTemplateDefault[] = [
  {
    occasionKey: 'BIRTHDAY',
    name: 'Birthday Wish',
    subject: 'Happy Birthday!',
    bodyHtml: emailBody({
      category: 'General',
      title: 'Happy Birthday!',
      blocks: [
        paragraph(
          'Happy Birthday, {{employeeName}}! Wishing you a wonderful year ahead, from everyone here.',
        ),
        regards,
      ],
    }),
    ccAllActive: true,
    category: 'General',
  },
  {
    occasionKey: 'NEW_JOINER_ANNOUNCEMENT',
    name: 'New Joiner Announcement',
    subject: 'Please welcome {{employeeName}} to {{companyName}}!',
    bodyHtml: emailBody({
      category: 'General',
      title: 'Please welcome {{employeeName}}',
      blocks: [
        paragraph('Hi team,'),
        paragraph(
          'Please join us in welcoming <strong>{{employeeName}}</strong>, who is joining us today as <strong>{{designation}}</strong>{{departmentLine}}.',
        ),
        optionalNote('About {{employeeName}}', '{{intro}}'),
        paragraph('Feel free to drop by and say hello!'),
        regards,
      ],
    }),
    ccAllActive: true,
    category: 'General',
  },
  {
    occasionKey: 'WORK_ANNIVERSARY',
    name: 'Work Anniversary Wish',
    subject: 'Happy Work Anniversary!',
    bodyHtml: emailBody({
      category: 'General',
      title: 'Happy Work Anniversary!',
      blocks: [
        paragraph(
          "Congratulations on your {{years}} work anniversary, {{employeeName}}! Thank you for everything you've contributed.",
        ),
        regards,
      ],
    }),
    ccAllActive: true,
    category: 'General',
  },

  // --- Attendance ---
  {
    occasionKey: 'ABSENT_MARKED',
    name: 'Marked Absent',
    subject: 'Marked Absent — {{date}}',
    bodyHtml: emailBody({
      category: 'Attendance',
      title: 'Marked Absent — {{date}}',
      blocks: [
        greet,
        paragraph(
          'You were marked absent for {{date}}. Contact HR if this looks wrong.',
        ),
        infoCard([row('Date', '{{date}}'), row('Status', status('Absent'))]),
      ],
    }),
    ccAllActive: false,
    category: 'Attendance',
  },
  {
    occasionKey: 'WFH_DECISION',
    name: 'Work From Home Decision',
    subject: 'Work From Home Request {{decision}}',
    bodyHtml: decisionBody({
      category: 'Attendance',
      title: 'Work From Home Request {{decision}}',
      message:
        'Your Work From Home request for {{date}} has been {{decision}}.',
      rows: [row('Date', '{{date}}'), row('Status', status('{{decision}}'))],
      commentsPlaceholder: '{{comments}}',
    }),
    ccAllActive: false,
    category: 'Attendance',
  },
  {
    occasionKey: 'REGULARIZATION_DECISION',
    name: 'Attendance Regularization Decision',
    subject: 'Regularization Request {{decision}}',
    bodyHtml: decisionBody({
      category: 'Attendance',
      title: 'Regularization Request {{decision}}',
      message:
        'Your attendance regularization request for {{date}} has been {{decision}}.',
      rows: [row('Date', '{{date}}'), row('Status', status('{{decision}}'))],
      commentsPlaceholder: '{{comments}}',
    }),
    ccAllActive: false,
    category: 'Attendance',
  },

  // --- Leave / Comp-Off / Overtime ---
  {
    occasionKey: 'LEAVE_DECISION',
    name: 'Leave Request Decision',
    subject: 'Leave Request {{decision}}',
    bodyHtml: decisionBody({
      category: 'Leave & Comp-Off',
      title: 'Leave Request {{decision}}',
      message:
        'Your leave request from {{startDate}} to {{endDate}} has been {{decision}}.',
      rows: [
        row('From', '{{startDate}}'),
        row('To', '{{endDate}}'),
        row('Status', status('{{decision}}')),
      ],
      commentsPlaceholder: '{{comments}}',
    }),
    ccAllActive: false,
    category: 'Leave & Comp-Off',
  },
  {
    occasionKey: 'COMP_OFF_DECISION',
    name: 'Comp-Off Request Decision',
    subject: 'Comp-Off Request {{decision}}',
    bodyHtml: decisionBody({
      category: 'Leave & Comp-Off',
      title: 'Comp-Off Request {{decision}}',
      message:
        'Your comp-off request for {{earnedForDate}} has been {{decision}}.',
      rows: [
        row('Earned for', '{{earnedForDate}}'),
        row('Status', status('{{decision}}')),
      ],
    }),
    ccAllActive: false,
    category: 'Leave & Comp-Off',
  },
  {
    occasionKey: 'OVERTIME_STATUS',
    name: 'Overtime Request Decision',
    subject: 'Overtime Request {{status}}',
    bodyHtml: decisionBody({
      category: 'Leave & Comp-Off',
      title: 'Overtime Request {{status}}',
      message:
        'Your overtime of {{hours}} hour(s) on {{date}} has been {{status}}.',
      rows: [
        row('Date', '{{date}}'),
        row('Hours', '{{hours}}'),
        row('Status', status('{{status}}')),
      ],
    }),
    ccAllActive: false,
    category: 'Leave & Comp-Off',
  },
  {
    occasionKey: 'LEAVE_ENCASHMENT_STATUS',
    name: 'Leave Encashment Decision',
    subject: 'Leave Encashment Request {{status}}',
    bodyHtml: decisionBody({
      category: 'Leave & Comp-Off',
      title: 'Leave Encashment Request {{status}}',
      message:
        'Your leave encashment request for {{days}} day(s) ({{amount}}) has been {{status}}.',
      rows: [
        row('Days', '{{days}}'),
        row('Amount', '{{amount}}'),
        row('Status', status('{{status}}')),
      ],
    }),
    ccAllActive: false,
    category: 'Leave & Comp-Off',
  },

  // --- Loans / Reimbursements / Payroll ---
  {
    occasionKey: 'LOAN_SANCTIONED',
    name: 'Loan Sanctioned',
    subject: 'Loan Sanctioned',
    bodyHtml: decisionBody({
      category: 'Payroll & Finance',
      title: 'Loan Sanctioned',
      message:
        'A {{loanType}} loan of {{principal}} has been sanctioned for you, repayable as {{emiAmount}}/month over {{tenureMonths}} month(s).',
      rows: [
        row('Loan type', '{{loanType}}'),
        row('Principal', '{{principal}}'),
        row('Monthly EMI', '{{emiAmount}}'),
        row('Tenure', '{{tenureMonths}} month(s)'),
        row('Status', status('Sanctioned')),
      ],
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },
  {
    occasionKey: 'LOAN_STATUS_UPDATE',
    name: 'Loan Status Update',
    subject: 'Loan {{status}}',
    bodyHtml: decisionBody({
      category: 'Payroll & Finance',
      title: 'Loan {{status}}',
      message: 'Your {{loanType}} loan status is now {{status}}.',
      rows: [
        row('Loan type', '{{loanType}}'),
        row('Status', status('{{status}}')),
      ],
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },
  {
    occasionKey: 'REIMBURSEMENT_STATUS',
    name: 'Reimbursement Claim Decision',
    subject: 'Reimbursement Claim {{status}}',
    bodyHtml: decisionBody({
      category: 'Payroll & Finance',
      title: 'Reimbursement Claim {{status}}',
      message:
        'Your reimbursement claim of {{amount}} for {{category}} has been {{status}}.',
      rows: [
        row('Amount', '{{amount}}'),
        row('Category', '{{category}}'),
        row('Status', status('{{status}}')),
      ],
      commentsPlaceholder: '{{comments}}',
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },
  {
    occasionKey: 'PAYSLIP_ISSUED',
    name: 'Payslip Issued',
    subject: 'Payslip for {{month}}/{{year}}',
    bodyHtml: emailBody({
      category: 'Payroll & Finance',
      title: 'Payslip for {{month}}/{{year}}',
      blocks: [
        greet,
        paragraph(
          'Your salary for {{month}}/{{year}} has been paid. Net pay: {{netPay}}. Your payslip is attached.',
        ),
        infoCard([
          row('Pay period', '{{month}}/{{year}}'),
          row('Net pay', '{{netPay}}'),
        ]),
        notice('Your payslip is attached to this email as a PDF.', 'info'),
      ],
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },
  {
    occasionKey: 'TAX_DECLARATION_VERIFIED',
    name: 'Tax Declaration Verified',
    subject: 'Tax Declaration Verified',
    bodyHtml: decisionBody({
      category: 'Payroll & Finance',
      title: 'Tax Declaration Verified',
      message:
        'Your tax declaration for FY {{financialYear}} has been verified.',
      rows: [
        row('Financial year', 'FY {{financialYear}}'),
        row('Status', status('Verified')),
      ],
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },
  {
    occasionKey: 'PERFORMANCE_RATING_PUBLISHED',
    name: 'Performance Rating Published',
    subject: 'Performance Rating Published',
    bodyHtml: decisionBody({
      category: 'Payroll & Finance',
      title: 'Performance Rating Published',
      message:
        'Your performance rating for FY {{financialYear}} has been published: {{rating}}.',
      rows: [
        row('Financial year', 'FY {{financialYear}}'),
        row('Rating', '{{rating}}'),
      ],
    }),
    ccAllActive: false,
    category: 'Payroll & Finance',
  },

  // --- Exit ---
  {
    occasionKey: 'OFFBOARDING_INITIATED',
    name: 'Offboarding Initiated',
    subject: 'Offboarding Process Initiated',
    bodyHtml: decisionBody({
      category: 'Exit',
      title: 'Offboarding Process Initiated',
      message:
        'Your offboarding has been initiated with a last working day of {{lastWorkingDay}}. HR will reach out with the exit checklist.',
      rows: [row('Last working day', '{{lastWorkingDay}}')],
    }),
    ccAllActive: false,
    category: 'Exit',
  },
  {
    occasionKey: 'SETTLEMENT_PROCESSED',
    name: 'Full & Final Settlement Processed',
    subject: 'Full & Final Settlement Processed',
    bodyHtml: decisionBody({
      category: 'Exit',
      title: 'Full & Final Settlement Processed',
      message:
        'Your full & final settlement has been processed. Net settlement amount: {{netSettlementAmount}} ({{netSettlementAmountInWords}}). Your payslip for this settlement will follow separately.',
      rows: [
        row('Net settlement amount', '{{netSettlementAmount}}'),
        row('In words', '{{netSettlementAmountInWords}}'),
      ],
    }),
    ccAllActive: false,
    category: 'Exit',
  },

  // --- Documents ---
  {
    occasionKey: 'DOCUMENT_STATUS',
    name: 'Document Review Decision',
    subject: 'Document {{status}}',
    bodyHtml: decisionBody({
      category: 'Documents',
      title: 'Document {{status}}',
      message: 'Your document "{{fileName}}" has been {{status}}.',
      rows: [
        row('Document', '{{fileName}}'),
        row('Status', status('{{status}}')),
      ],
      commentsLabel: 'Reason',
      commentsPlaceholder: '{{reason}}',
    }),
    ccAllActive: false,
    category: 'Documents',
  },

  // --- Account / Auth ---
  {
    occasionKey: 'WELCOME_EMAIL',
    name: 'New Employee Welcome',
    subject: 'Welcome to {{companyName}} HRMS',
    bodyHtml: CREDENTIALS_BODY,
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    occasionKey: 'LOGIN_CREDENTIALS_RESENT',
    name: 'Login Credentials Resent',
    subject: 'Your {{companyName}} HRMS login credentials',
    bodyHtml: CREDENTIALS_BODY,
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    occasionKey: 'FOUNDER_ACCOUNT_WELCOME',
    name: 'Founder Account Welcome',
    subject: 'Welcome to {{companyName}} HRMS — your account is ready',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: 'Your account is ready',
      blocks: [
        greet,
        paragraph(
          'Thank you for creating your account with {{companyName}} HRMS.',
        ),
        paragraph(
          "Your organization, <strong>{{companyName}}</strong>, is now set up and ready to go. Here's what to do next:",
        ),
        orderedSteps([
          '<strong>Log in</strong> using the email and password you just created.',
          '<strong>Complete your Organization Setup</strong> — company profile, registration details, contact info, branding, and a few other one-time steps.',
          "Once that's done, you're all set to start using the HRMS — add employees, manage attendance, run payroll, and more.",
        ]),
        button('{{loginUrl}}', 'Log in to your account'),
        paragraph(
          "If you didn't create this account, you can safely ignore this email.",
        ),
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    occasionKey: 'PASSWORD_RESET',
    name: 'Password Reset',
    subject: '{{companyName}} HRMS - Password Reset',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: 'Reset your password',
      blocks: [
        hello,
        paragraph(
          'Click the button below to reset your password. This link expires in 30 minutes.',
        ),
        button('{{resetUrl}}', 'Reset password'),
        `<p style="margin:0 0 6px;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#586074;">If the button doesn't work, copy and paste this link into your browser:</p>` +
          `<p style="margin:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;word-break:break-all;"><a href="{{resetUrl}}" style="color:#5546e0;text-decoration:underline;">{{resetUrl}}</a></p>`,
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    occasionKey: 'ACCOUNT_ACTIVATED',
    name: 'Account Activated',
    subject: 'Welcome to your HRMS account',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: 'Welcome to your HRMS account',
      blocks: [
        hello,
        paragraph(
          'Your account is now active. From here on, all HRMS communication — leave approvals, payslips, announcements, and more — will be sent to this address ({{email}}).',
        ),
        infoCard([row('Email', '{{email}}'), row('Status', status('Active'))]),
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    occasionKey: 'SETUP_COMPLETE',
    name: 'Organization Setup Complete',
    subject: 'Your {{companyName}} HRMS Setup Is Complete',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: "You're all set",
      blocks: [
        greet,
        paragraph(
          'Setup for {{companyName}} is complete — the HRMS is ready to use. Log in to your account and start managing your workforce from one place.',
        ),
        notice(
          '<strong>Setup complete.</strong> Your organization is ready to use HRMS.',
          'success',
        ),
        paragraph('<strong>You can now:</strong>'),
        checkList([
          'Add and manage employees',
          'Manage attendance',
          'Manage leave',
          'Process payroll',
          'Configure HRMS settings',
          'Access workforce information and reports',
        ]),
        button('{{loginUrl}}', 'Log in to HRMS'),
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    // Fires from LettersService.send() — HR/Admin reviews the generated
    // PDF (any letter type: Appointment, Relieving, Experience...) and
    // clicks Send; {{letterName}} names whichever template was sent.
    occasionKey: 'LETTER_SENT',
    name: 'Letter Sent',
    subject: 'Your {{letterName}} from {{companyName}}',
    bodyHtml: emailBody({
      category: 'Documents',
      title: 'Your {{letterName}}',
      blocks: [
        greet,
        paragraph('Please find your {{letterName}} attached.'),
        infoCard([row('Document', '{{letterName}}')]),
        notice('Your letter is attached to this email as a PDF.', 'info'),
        regards,
      ],
    }),
    ccAllActive: false,
    category: 'Documents',
  },
  {
    // Fires from AuthService.changePassword() (voluntary changes only — the
    // first-login change already sends ACCOUNT_ACTIVATED) and resetPassword().
    // A security notice, so it never carries the password itself.
    occasionKey: 'PASSWORD_CHANGED',
    name: 'Password Changed',
    subject: 'Your password was changed',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: 'Your password was changed',
      blocks: [
        hello,
        paragraph(
          'The password for your HRMS account was changed on {{changedAt}}.',
        ),
        infoCard([row('Changed on', '{{changedAt}}')]),
        notice(
          "If you didn't make this change, contact your HR administrator immediately.",
          'warning',
        ),
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    // Fires from EmployeesService.update() when an employee's role actually changes.
    occasionKey: 'ROLE_CHANGED',
    name: 'Role Changed',
    subject: 'Your HRMS role was updated',
    bodyHtml: emailBody({
      category: 'Account & Access',
      title: 'Your HRMS role was updated',
      blocks: [
        hello,
        paragraph(
          'Your role in the HRMS was changed from {{previousRole}} to {{newRole}}.',
        ),
        infoCard([
          row('Previous role', '{{previousRole}}'),
          row('New role', '{{newRole}}'),
        ]),
        notice(
          "If you weren't expecting this change, contact your HR administrator.",
          'info',
        ),
      ],
    }),
    ccAllActive: false,
    category: 'Account & Access',
  },
  {
    // Fires from OffboardingService.complete() — sent to the PERSONAL email only
    // (the work mailbox is deactivated by the same action), and skipped when none is on file.
    occasionKey: 'EXIT_COMPLETED',
    name: 'Exit Completed',
    subject: 'Your exit process is complete',
    bodyHtml: emailBody({
      category: 'Exit',
      title: 'Your exit process is complete',
      blocks: [
        greet,
        paragraph(
          'Your exit process has been completed and your HRMS access has now been closed.',
        ),
        infoCard([row('Last working day', '{{lastWorkingDay}}')]),
        paragraph('Thank you for your time with us.'),
      ],
    }),
    ccAllActive: false,
    category: 'Exit',
  },
  {
    // Fires from ApprovalsDigestService (weekday mornings) — one email per approver, and only
    // when at least one request is waiting. Each count is '' when zero, which hides its row.
    occasionKey: 'APPROVALS_DIGEST',
    name: 'Pending Approvals Digest',
    subject: 'Pending approvals: {{totalPending}} waiting for your review',
    bodyHtml: emailBody({
      category: 'General',
      title: 'Pending approvals',
      blocks: [
        greet,
        paragraph('{{totalPending}} request(s) are waiting for your review.'),
        infoCard(
          [
            row('Leave requests', '{{leaveCount}}', '{{leaveCount}}'),
            row(
              'Attendance regularizations',
              '{{regularizationCount}}',
              '{{regularizationCount}}',
            ),
            row('Work From Home requests', '{{wfhCount}}', '{{wfhCount}}'),
            row('Comp-off requests', '{{compOffCount}}', '{{compOffCount}}'),
            row('Overtime requests', '{{overtimeCount}}', '{{overtimeCount}}'),
            row(
              'Leave encashments',
              '{{encashmentCount}}',
              '{{encashmentCount}}',
            ),
            row(
              'Reimbursement claims',
              '{{reimbursementCount}}',
              '{{reimbursementCount}}',
            ),
            row('Loan / advance requests', '{{loanCount}}', '{{loanCount}}'),
          ],
          { dividers: false },
        ),
        button('{{reviewUrl}}', 'Review requests'),
        mutedText(
          'You receive this summary at most once a day, and only when something is waiting.',
        ),
      ],
    }),
    ccAllActive: false,
    category: 'General',
  },
];

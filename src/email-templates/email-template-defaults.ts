// Default occasion-based email templates seeded for every new org, mirroring
// the content HrEventsService used to hardcode inline (see the git history of
// sendBirthdayWish/sendAnniversaryWish before this module existed). Content
// is equivalent, not verbatim — the hardcoded strings had no company
// signature block at all, so one is added here using the
// {{companyName}}/{{companyPhone}}/{{companyWebsite}}/{{companyEmail}}/
// {{companyAddress}} placeholders EmailTemplatesService.render() supports.
export interface EmailTemplateDefault {
  occasionKey: string;
  name: string;
  subject: string;
  bodyHtml: string;
  ccAllActive: boolean;
}

export const EMAIL_TEMPLATE_DEFAULTS: EmailTemplateDefault[] = [
  {
    occasionKey: 'BIRTHDAY',
    name: 'Birthday Wish',
    subject: 'Happy Birthday!',
    bodyHtml:
      '<p>Happy Birthday, {{employeeName}}! Wishing you a wonderful year ahead, from everyone here.</p>' +
      '<p>Warm regards,<br/>{{companyName}}</p>' +
      '<p style="color:#888;font-size:12px;">{{companyName}} | {{companyAddress}} | {{companyPhone}} | {{companyEmail}} | {{companyWebsite}}</p>',
    ccAllActive: true,
  },
  {
    occasionKey: 'NEW_JOINER_ANNOUNCEMENT',
    name: 'New Joiner Announcement',
    subject: 'Please welcome {{employeeName}} to {{companyName}}!',
    bodyHtml:
      '<p>Hi team,</p>' +
      '<p>Please join us in welcoming <strong>{{employeeName}}</strong>, who is joining us today as <strong>{{designation}}</strong>{{departmentLine}}.</p>' +
      '<p>{{intro}}</p>' +
      '<p>Feel free to drop by and say hello!</p>' +
      '<p>Warm regards,<br/>{{companyName}}</p>' +
      '<p style="color:#888;font-size:12px;">{{companyName}} | {{companyAddress}} | {{companyPhone}} | {{companyEmail}} | {{companyWebsite}}</p>',
    ccAllActive: true,
  },
  {
    occasionKey: 'WORK_ANNIVERSARY',
    name: 'Work Anniversary Wish',
    subject: 'Happy Work Anniversary!',
    bodyHtml:
      "<p>Congratulations on your {{years}} work anniversary, {{employeeName}}! Thank you for everything you've contributed.</p>" +
      '<p>Warm regards,<br/>{{companyName}}</p>' +
      '<p style="color:#888;font-size:12px;">{{companyName}} | {{companyAddress}} | {{companyPhone}} | {{companyEmail}} | {{companyWebsite}}</p>',
    ccAllActive: true,
  },

  // --- Attendance ---
  {
    occasionKey: 'ABSENT_MARKED',
    name: 'Marked Absent',
    subject: 'Marked Absent — {{date}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>You were marked absent for {{date}}. Contact HR if this looks wrong.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'WFH_DECISION',
    name: 'Work From Home Decision',
    subject: 'Work From Home Request {{decision}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your Work From Home request for {{date}} has been {{decision}}.</p><p>{{comments}}</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'REGULARIZATION_DECISION',
    name: 'Attendance Regularization Decision',
    subject: 'Regularization Request {{decision}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your attendance regularization request for {{date}} has been {{decision}}.</p><p>{{comments}}</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },

  // --- Leave / Comp-Off / Overtime ---
  {
    occasionKey: 'LEAVE_DECISION',
    name: 'Leave Request Decision',
    subject: 'Leave Request {{decision}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your leave request from {{startDate}} to {{endDate}} has been {{decision}}.</p><p>{{comments}}</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'COMP_OFF_DECISION',
    name: 'Comp-Off Request Decision',
    subject: 'Comp-Off Request {{decision}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your comp-off request for {{earnedForDate}} has been {{decision}}.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'OVERTIME_STATUS',
    name: 'Overtime Request Decision',
    subject: 'Overtime Request {{status}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your overtime of {{hours}} hour(s) on {{date}} has been {{status}}.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'LEAVE_ENCASHMENT_STATUS',
    name: 'Leave Encashment Decision',
    subject: 'Leave Encashment Request {{status}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your leave encashment request for {{days}} day(s) ({{amount}}) has been {{status}}.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },

  // --- Loans / Reimbursements / Payroll ---
  {
    occasionKey: 'LOAN_SANCTIONED',
    name: 'Loan Sanctioned',
    subject: 'Loan Sanctioned',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>A {{loanType}} loan of {{principal}} has been sanctioned for you, repayable as {{emiAmount}}/month over {{tenureMonths}} month(s).</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'LOAN_STATUS_UPDATE',
    name: 'Loan Status Update',
    subject: 'Loan {{status}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your {{loanType}} loan status is now {{status}}.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'REIMBURSEMENT_STATUS',
    name: 'Reimbursement Claim Decision',
    subject: 'Reimbursement Claim {{status}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your reimbursement claim of {{amount}} for {{category}} has been {{status}}.</p><p>{{comments}}</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'PAYSLIP_ISSUED',
    name: 'Payslip Issued',
    subject: 'Payslip for {{month}}/{{year}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your salary for {{month}}/{{year}} has been paid. Net pay: {{netPay}}. Your payslip is attached.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'TAX_DECLARATION_VERIFIED',
    name: 'Tax Declaration Verified',
    subject: 'Tax Declaration Verified',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your tax declaration for FY {{financialYear}} has been verified.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'PERFORMANCE_RATING_PUBLISHED',
    name: 'Performance Rating Published',
    subject: 'Performance Rating Published',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your performance rating for FY {{financialYear}} has been published: {{rating}}.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },

  // --- Exit ---
  {
    occasionKey: 'OFFBOARDING_INITIATED',
    name: 'Offboarding Initiated',
    subject: 'Offboarding Process Initiated',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your offboarding has been initiated with a last working day of {{lastWorkingDay}}. HR will reach out with the exit checklist.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'SETTLEMENT_PROCESSED',
    name: 'Full & Final Settlement Processed',
    subject: 'Full & Final Settlement Processed',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your full & final settlement has been processed. Net settlement amount: {{netSettlementAmount}} ({{netSettlementAmountInWords}}). Your payslip for this settlement will follow separately.</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },

  // --- Documents ---
  {
    occasionKey: 'DOCUMENT_STATUS',
    name: 'Document Review Decision',
    subject: 'Document {{status}}',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Your document "{{fileName}}" has been {{status}}.</p><p>{{reason}}</p><p>{{companyName}}</p>',
    ccAllActive: false,
  },

  // --- Account / Auth ---
  {
    occasionKey: 'WELCOME_EMAIL',
    name: 'New Employee Welcome',
    subject: 'Welcome to {{companyName}} HRMS',
    bodyHtml:
      '<p>Hello {{employeeName}},</p><p>Your account on {{companyName}} HRMS is ready. Here are your login details:</p>' +
      '<p>Login URL: <a href="{{loginUrl}}">{{loginUrl}}</a><br/>Employee ID: <strong>{{employeeId}}</strong><br/>Email: <strong>{{email}}</strong><br/>Password: <strong>{{password}}</strong></p>' +
      "<p>You'll be asked to set a new password the first time you sign in. Please keep these details confidential.</p>",
    ccAllActive: false,
  },
  {
    occasionKey: 'LOGIN_CREDENTIALS_RESENT',
    name: 'Login Credentials Resent',
    subject: 'Your {{companyName}} HRMS login credentials',
    bodyHtml:
      '<p>Hello {{employeeName}},</p><p>Your account on {{companyName}} HRMS is ready. Here are your login details:</p>' +
      '<p>Login URL: <a href="{{loginUrl}}">{{loginUrl}}</a><br/>Employee ID: <strong>{{employeeId}}</strong><br/>Email: <strong>{{email}}</strong><br/>Password: <strong>{{password}}</strong></p>' +
      "<p>You'll be asked to set a new password the first time you sign in. Please keep these details confidential.</p>",
    ccAllActive: false,
  },
  {
    occasionKey: 'FOUNDER_ACCOUNT_WELCOME',
    name: 'Founder Account Welcome',
    subject: 'Welcome to {{companyName}} HRMS — your account is ready',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Thank you for creating your account with {{companyName}} HRMS.</p>' +
      "<p>Your organization, <strong>{{companyName}}</strong>, is now set up and ready to go. Here's what to do next:</p>" +
      '<ol><li><strong>Log in</strong> using the email and password you just created.</li>' +
      '<li><strong>Complete your Organization Setup</strong> — company profile, registration details, contact info, branding, and a few other one-time steps.</li>' +
      "<li>Once that's done, you're all set to start using the HRMS — add employees, manage attendance, run payroll, and more.</li></ol>" +
      '<p><a href="{{loginUrl}}">Log in to your account →</a></p>' +
      "<p>If you didn't create this account, you can safely ignore this email.</p>",
    ccAllActive: false,
  },
  {
    occasionKey: 'PASSWORD_RESET',
    name: 'Password Reset',
    subject: '{{companyName}} HRMS - Password Reset',
    bodyHtml:
      '<p>Hello {{employeeName}},</p><p>Click the link below to reset your password. This link expires in 30 minutes.</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'ACCOUNT_ACTIVATED',
    name: 'Account Activated',
    subject: 'Welcome to your HRMS account',
    bodyHtml:
      '<p>Hello {{employeeName}},</p><p>Your account is now active. From here on, all HRMS communication — leave approvals, payslips, announcements, and more — will be sent to this address ({{email}}).</p>',
    ccAllActive: false,
  },
  {
    occasionKey: 'SETUP_COMPLETE',
    name: 'Organization Setup Complete',
    subject: 'Your {{companyName}} HRMS Setup Is Complete',
    bodyHtml:
      '<p>Hi {{employeeName}},</p><p>Setup for {{companyName}} is complete — the HRMS is ready to use.</p>',
    ccAllActive: false,
  },
];

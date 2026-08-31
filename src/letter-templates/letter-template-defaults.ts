import { LetterDataProfile } from '@prisma/client';

export interface LetterTemplateDefault {
  key: string;
  name: string;
  title: string;
  addressedToEmployee: boolean;
  dataProfile: LetterDataProfile;
  bodyText: string;
}

// Seeded at registration (LetterTemplatesService.seedDefaults, same
// integration point as EmailTemplatesService's Birthday/Work Anniversary)
// — starting content for the 7 built-in letter types, fully editable
// afterward from Organization Settings > Letter Templates. Every
// {{placeholder}} used here is documented in LettersService's variable
// list; BASIC vars (employeeName, firstName, employeeId, designation,
// department, employeeType, joiningDate, companyName, companyAddress,
// issueDate) are always available, the rest depend on dataProfile.
export const LETTER_TEMPLATE_DEFAULTS: LetterTemplateDefault[] = [
  {
    key: 'offerLetter',
    name: 'Offer Letter',
    title: 'Offer of Employment',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'We are pleased to offer you the position of {{designation}} in the {{department}} department at {{companyName}}, on a {{employeeType}} basis. We were impressed by your background and are confident you will be a valuable addition to our team.',
      "Your proposed date of joining is {{joiningDate}}. Your role, compensation, and other terms of employment will be governed by the company's policies as communicated to you separately and updated from time to time.",
      'This offer is subject to satisfactory verification of the documents and information provided by you during the hiring process. Please confirm your acceptance of this offer at the earliest.',
      'We look forward to welcoming you to {{companyName}}.',
    ].join('\n'),
  },
  {
    key: 'appointmentLetter',
    name: 'Appointment Letter',
    title: 'Letter of Appointment',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'Further to your offer of employment, we are pleased to confirm your appointment as {{designation}} in the {{department}} department at {{companyName}}, effective {{joiningDate}}.',
      'Your employment is on a {{employeeType}} basis and will be governed by the terms and conditions, policies, and code of conduct of the company, as amended from time to time.',
      'We are confident that you will find your role both challenging and rewarding, and we look forward to a long and mutually beneficial association.',
    ].join('\n'),
  },
  {
    key: 'relievingLetter',
    name: 'Relieving Letter',
    title: 'Relieving Letter',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.EXIT,
    bodyText: [
      'Dear {{employeeName}},',
      'This is to confirm that you have been relieved from your duties as {{designation}} at {{companyName}}, with effect from the close of business on {{lastWorkingDay}}.',
      'We confirm that all dues, if any, have been settled as per company policy. Your conduct during your tenure with us was satisfactory.',
      'We wish you the very best in your future endeavors.',
    ].join('\n'),
  },
  {
    key: 'experienceLetter',
    name: 'Experience Letter',
    title: 'Experience Letter',
    addressedToEmployee: false,
    dataProfile: LetterDataProfile.EXIT,
    bodyText: [
      'This is to certify that {{employeeName}} (Employee ID: {{employeeId}}) was employed with {{companyName}} as {{designation}} in the {{department}} department, from {{joiningDate}} to {{lastWorkingDay}}.',
      'During this period, we found {{firstName}} to be sincere, hardworking, and professional in conduct. {{firstName}} was a valuable member of the team and contributed positively to the organization.',
      'We wish {{firstName}} success in all future endeavors.',
    ].join('\n'),
  },
  {
    key: 'experienceCertificate',
    name: 'Experience Certificate',
    title: 'Certificate of Experience',
    addressedToEmployee: false,
    dataProfile: LetterDataProfile.EXIT,
    bodyText: [
      'This is to certify that {{employeeName}} (Employee ID: {{employeeId}}) worked with {{companyName}} as {{designation}} from {{joiningDate}} to {{lastWorkingDay}}.',
      'This certificate is issued at the request of the employee for whatever purpose it may serve.',
    ].join('\n'),
  },
  {
    key: 'salaryCertificate',
    name: 'Salary Certificate',
    title: 'Salary Certificate',
    addressedToEmployee: false,
    dataProfile: LetterDataProfile.PAYROLL,
    bodyText: [
      'This is to certify that {{employeeName}} (Employee ID: {{employeeId}}) is employed with {{companyName}} as {{designation}} in the {{department}} department, since {{joiningDate}}.',
      "As per our records for {{month}} {{year}}, {{firstName}}'s monthly gross salary is {{grossSalary}} and net (take-home) salary is {{netPay}}. The annual cost-to-company (CTC) is approximately {{annualCTC}}.",
      'This certificate is issued at the request of the employee for whatever purpose it may serve.',
    ].join('\n'),
  },
  {
    key: 'fullFinalSettlement',
    name: 'Full & Final Settlement',
    title: 'Full & Final Settlement Statement',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.SETTLEMENT,
    bodyText: [
      'Dear {{employeeName}},',
      'This letter confirms the full and final settlement of your dues with {{companyName}}, following the end of your employment as {{designation}}, with your last working day being {{lastWorkingDay}}.',
      'Settlement breakdown:',
      '  Pending Salary: {{pendingSalary}}',
      '  Leave Encashment: {{leaveEncashment}}',
      '  Bonus: {{bonus}}',
      '  Gratuity: {{gratuity}}',
      '  Less: Recoveries: {{recoveries}}',
      '  Less: Loan Balance Recovered: {{loanRecovered}}',
      '  Less: Notice Period Recovery: {{noticePeriodRecovery}}',
      '  Total Deductions: {{totalDeductions}}',
      'Net Amount Payable: {{netPayable}} ({{netPayableInWords}})',
      'This settlement is full and final; no further amounts are due to or from either party in respect of your employment.',
    ].join('\n'),
  },
];

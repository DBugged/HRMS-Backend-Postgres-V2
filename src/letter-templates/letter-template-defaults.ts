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
// — starting content for the 17 built-in letter types, fully editable
// afterward from Organization Settings > Letter Templates. Every
// {{placeholder}} used here is documented in LettersService's variable
// list; BASIC vars (employeeName, firstName, employeeId, designation,
// department, employeeType, joiningDate, companyName, companyAddress,
// issueDate, probationEndDate) are always available, the rest depend on
// dataProfile (EXIT adds lastWorkingDay/reason/noticeDate, PAYROLL adds
// month/year/grossSalary/netPay/annualCTC, SETTLEMENT adds the F&F
// breakdown).
//
// NDA and Non-Compete are legal agreements, not data-driven letters —
// the wording below is generic starting content only, same as every
// other template here is described as "starting content ... fully
// editable" — it is NOT a substitute for your own legal counsel's
// review before actual use, and the non-compete clause is deliberately
// scoped to the employment term only (post-employment restraint of
// trade is generally unenforceable under Indian Contract Act s.27).
//
// Warning Letter has no structured "incident/reason" data source in this
// app (there's no disciplinary-record model) — its body is intentionally
// generic; HR is expected to edit the org's own template wording for the
// specific case before generating, the same way any admin-authored
// template can be edited, rather than this being auto-filled per incident
// like the other letters are.
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
  {
    key: 'confirmationLetter',
    name: 'Confirmation Letter',
    title: 'Letter of Confirmation',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'We are pleased to inform you that, having successfully completed your probationary period ending {{probationEndDate}}, your services with {{companyName}} stand confirmed as {{designation}} in the {{department}} department, effective {{issueDate}}.',
      'All other terms and conditions of your employment remain unchanged. We look forward to your continued contribution to the organization.',
    ].join('\n'),
  },
  {
    key: 'probationExtensionLetter',
    name: 'Probation Extension Letter',
    title: 'Extension of Probationary Period',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'This is to inform you that your probationary period as {{designation}} in the {{department}} department has been extended, and your revised probation end date is now {{probationEndDate}}.',
      'Please continue to discuss your performance and any support you may need with your reporting manager during this period.',
    ].join('\n'),
  },
  {
    key: 'promotionLetter',
    name: 'Promotion Letter',
    title: 'Letter of Promotion',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'We are pleased to inform you that, in recognition of your performance and contribution, you have been promoted to the position of {{designation}} in the {{department}} department, effective {{issueDate}}.',
      'Please note that any revision to your compensation arising from this promotion will be communicated to you separately. Congratulations, and we look forward to your continued success at {{companyName}}.',
    ].join('\n'),
  },
  {
    key: 'incrementLetter',
    name: 'Increment Letter',
    title: 'Letter of Salary Revision',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.PAYROLL,
    bodyText: [
      'Dear {{employeeName}},',
      'We are pleased to inform you that your compensation has been revised in recognition of your performance and contribution to {{companyName}}.',
      'Your revised annual cost-to-company (CTC) is approximately {{annualCTC}}, based on a monthly gross salary of {{grossSalary}} and net (take-home) salary of {{netPay}} as of {{month}} {{year}}.',
      'This revision reflects our continued confidence in your abilities, and we look forward to your ongoing contribution to the team.',
    ].join('\n'),
  },
  {
    key: 'transferLetter',
    name: 'Transfer Letter',
    title: 'Letter of Transfer',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'This is to inform you that, in the interest of business requirements, you have been transferred to the {{department}} department as {{designation}}, effective {{issueDate}}.',
      'All other terms and conditions of your employment remain unchanged. Please coordinate with your new reporting manager for a smooth transition.',
    ].join('\n'),
  },
  {
    key: 'resignationAcceptance',
    name: 'Resignation Acceptance Letter',
    title: 'Acceptance of Resignation',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.EXIT,
    bodyText: [
      'Dear {{employeeName}},',
      'We acknowledge and accept your resignation submitted on {{noticeDate}} from your position as {{designation}} at {{companyName}}, for {{reason}}.',
      'As per our records, your last working day will be {{lastWorkingDay}}. Please ensure a smooth handover of your responsibilities and complete the exit formalities before this date.',
      'We thank you for your contribution during your tenure with us and wish you success in your future endeavors.',
    ].join('\n'),
  },
  {
    key: 'terminationLetter',
    name: 'Termination Letter',
    title: 'Letter of Termination',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.EXIT,
    bodyText: [
      'Dear {{employeeName}},',
      'This letter is to inform you that your employment with {{companyName}} as {{designation}} is being terminated, for {{reason}}, effective {{lastWorkingDay}}.',
      'Your full and final settlement will be processed as per company policy. Please ensure the return of all company property and complete the exit formalities before your last working day.',
    ].join('\n'),
  },
  {
    key: 'warningLetter',
    name: 'Warning Letter',
    title: 'Letter of Warning',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'Dear {{employeeName}},',
      'This letter serves as a formal warning regarding a conduct/performance matter discussed with you, as {{designation}} in the {{department}} department.',
      'You are advised to take immediate corrective action. Please note that failure to improve may result in further disciplinary action, up to and including termination of employment, in accordance with company policy.',
      'We trust you will treat this matter with the seriousness it deserves.',
    ].join('\n'),
  },
  {
    key: 'nda',
    name: 'Non-Disclosure Agreement',
    title: 'Non-Disclosure Agreement',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'This Non-Disclosure Agreement is entered into between {{companyName}} ("Company") and {{employeeName}} ("Employee"), effective {{issueDate}}.',
      'The Employee acknowledges that in the course of employment as {{designation}}, they may have access to confidential and proprietary information belonging to the Company, its clients, and its business partners, including but not limited to business plans, client data, financial information, trade secrets, and software or process know-how.',
      'The Employee agrees not to disclose, share, or use any such confidential information for any purpose other than the performance of their duties, both during the course of employment and after its termination for any reason.',
      'This agreement does not restrict disclosure required by law or by a competent court or authority. This document is a starting template only and should be reviewed by legal counsel before use.',
    ].join('\n'),
  },
  {
    key: 'nonCompeteAgreement',
    name: 'Non-Compete Agreement',
    title: 'Non-Compete Agreement',
    addressedToEmployee: true,
    dataProfile: LetterDataProfile.BASIC,
    bodyText: [
      'This Non-Compete Agreement is entered into between {{companyName}} ("Company") and {{employeeName}} ("Employee"), effective {{issueDate}}.',
      'During the term of employment as {{designation}}, the Employee agrees not to engage in any business, employment, or consulting activity that directly competes with the Company, without prior written consent from the Company.',
      'This agreement is limited to the period of active employment; any restriction intended to apply after the end of employment must be separately reviewed for enforceability under applicable law before being relied upon.',
      'This document is a starting template only and should be reviewed by legal counsel before use.',
    ].join('\n'),
  },
];

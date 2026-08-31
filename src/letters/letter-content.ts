// Purpose: Pure content builders — one per LetterType — turning real employee/org/computed data into a
//   letter's title + body paragraphs. No DB access, no PDF rendering; letters.service.ts fetches the data
//   and letter-pdf.service.ts renders what these functions return.
// Important: text is deliberately plain, professional boilerplate (not a rich merge-template system like
//   Email Templates) — this app has no per-letter template editor, and building one wasn't asked for here.
import { formatDateDisplay } from '../payroll/format-date';
import { amountInWords } from '../payroll/number-to-words';

export interface LetterEmployeeInfo {
  name: string;
  employeeId: string;
  designation: string;
  departmentName: string | null;
  employeeType: string;
  joiningDate: Date;
}

export interface LetterContent {
  title: string;
  paragraphs: string[];
}

const dash = (v: string | null | undefined) => (v && v.trim() ? v : '—');

export function offerLetterContent(
  employee: LetterEmployeeInfo,
  companyName: string,
): LetterContent {
  return {
    title: 'Offer of Employment',
    paragraphs: [
      `Dear ${employee.name},`,
      `We are pleased to offer you the position of ${dash(employee.designation)} in the ${dash(employee.departmentName)} department at ${companyName}, on a ${employee.employeeType} basis. We were impressed by your background and are confident you will be a valuable addition to our team.`,
      `Your proposed date of joining is ${formatDateDisplay(employee.joiningDate)}. Your role, compensation, and other terms of employment will be governed by the company's policies as communicated to you separately and updated from time to time.`,
      `This offer is subject to satisfactory verification of the documents and information provided by you during the hiring process. Please confirm your acceptance of this offer at the earliest.`,
      `We look forward to welcoming you to ${companyName}.`,
    ],
  };
}

export function appointmentLetterContent(
  employee: LetterEmployeeInfo,
  companyName: string,
): LetterContent {
  return {
    title: 'Letter of Appointment',
    paragraphs: [
      `Dear ${employee.name},`,
      `Further to your offer of employment, we are pleased to confirm your appointment as ${dash(employee.designation)} in the ${dash(employee.departmentName)} department at ${companyName}, effective ${formatDateDisplay(employee.joiningDate)}.`,
      `Your employment is on a ${employee.employeeType} basis and will be governed by the terms and conditions, policies, and code of conduct of the company, as amended from time to time.`,
      `We are confident that you will find your role both challenging and rewarding, and we look forward to a long and mutually beneficial association.`,
    ],
  };
}

export function relievingLetterContent(
  employee: LetterEmployeeInfo,
  companyName: string,
  lastWorkingDay: string,
): LetterContent {
  return {
    title: 'Relieving Letter',
    paragraphs: [
      `Dear ${employee.name},`,
      `This is to confirm that you have been relieved from your duties as ${dash(employee.designation)} at ${companyName}, with effect from the close of business on ${formatDateDisplay(lastWorkingDay)}.`,
      `We confirm that all dues, if any, have been settled as per company policy. Your conduct during your tenure with us was satisfactory.`,
      `We wish you the very best in your future endeavors.`,
    ],
  };
}

export function experienceLetterContent(
  employee: LetterEmployeeInfo,
  companyName: string,
  lastWorkingDay: string,
): LetterContent {
  return {
    title: 'Experience Letter',
    paragraphs: [
      `This is to certify that ${employee.name} (Employee ID: ${employee.employeeId}) was employed with ${companyName} as ${dash(employee.designation)} in the ${dash(employee.departmentName)} department, from ${formatDateDisplay(employee.joiningDate)} to ${formatDateDisplay(lastWorkingDay)}.`,
      `During this period, we found ${employee.name.split(' ')[0]} to be sincere, hardworking, and professional in conduct. ${employee.name.split(' ')[0]} was a valuable member of the team and contributed positively to the organization.`,
      `We wish ${employee.name.split(' ')[0]} success in all future endeavors.`,
    ],
  };
}

export function experienceCertificateContent(
  employee: LetterEmployeeInfo,
  companyName: string,
  lastWorkingDay: string,
): LetterContent {
  return {
    title: 'Certificate of Experience',
    paragraphs: [
      `This is to certify that ${employee.name} (Employee ID: ${employee.employeeId}) worked with ${companyName} as ${dash(employee.designation)} from ${formatDateDisplay(employee.joiningDate)} to ${formatDateDisplay(lastWorkingDay)}.`,
      `This certificate is issued at the request of the employee for whatever purpose it may serve.`,
    ],
  };
}

export interface SalaryCertificatePeriod {
  month: number;
  year: number;
  grossSalary: number;
  netPay: number;
  ctcMonthly: number;
}

export function salaryCertificateContent(
  employee: LetterEmployeeInfo,
  companyName: string,
  period: SalaryCertificatePeriod,
  currencySymbol: string,
): LetterContent {
  const MONTHS = [
    '',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const fmt = (n: number) =>
    `${currencySymbol}${currencySymbol === 'Rs.' ? ' ' : ''}${Math.round(n).toLocaleString('en-IN')}`;
  return {
    title: 'Salary Certificate',
    paragraphs: [
      `This is to certify that ${employee.name} (Employee ID: ${employee.employeeId}) is employed with ${companyName} as ${dash(employee.designation)} in the ${dash(employee.departmentName)} department, since ${formatDateDisplay(employee.joiningDate)}.`,
      `As per our records for ${MONTHS[period.month]} ${period.year}, ${employee.name.split(' ')[0]}'s monthly gross salary is ${fmt(period.grossSalary)} and net (take-home) salary is ${fmt(period.netPay)}. The annual cost-to-company (CTC) is approximately ${fmt(period.ctcMonthly * 12)}.`,
      `This certificate is issued at the request of the employee for whatever purpose it may serve.`,
    ],
  };
}

export interface SettlementFigures {
  lastWorkingDay: string;
  pendingSalaryAmount: number;
  leaveEncashmentAmount: number;
  bonusAmount: number;
  gratuityAmount: number;
  recoveriesAmount: number;
  loanBalanceRecovered: number;
  noticePeriodRecovery: number;
  netSettlementAmount: number;
}

export function fullFinalSettlementContent(
  employee: LetterEmployeeInfo,
  companyName: string,
  settlement: SettlementFigures,
  currencySymbol: string,
): LetterContent {
  const fmt = (n: number) =>
    `${currencySymbol}${currencySymbol === 'Rs.' ? ' ' : ''}${Math.round(n).toLocaleString('en-IN')}`;
  const deductions =
    settlement.recoveriesAmount +
    settlement.loanBalanceRecovered +
    settlement.noticePeriodRecovery;
  return {
    title: 'Full & Final Settlement Statement',
    paragraphs: [
      `Dear ${employee.name},`,
      `This letter confirms the full and final settlement of your dues with ${companyName}, following the end of your employment as ${dash(employee.designation)}, with your last working day being ${formatDateDisplay(settlement.lastWorkingDay)}.`,
      `Settlement breakdown:`,
      `  Pending Salary: ${fmt(settlement.pendingSalaryAmount)}`,
      `  Leave Encashment: ${fmt(settlement.leaveEncashmentAmount)}`,
      `  Bonus: ${fmt(settlement.bonusAmount)}`,
      `  Gratuity: ${fmt(settlement.gratuityAmount)}`,
      `  Less: Recoveries: ${fmt(settlement.recoveriesAmount)}`,
      `  Less: Loan Balance Recovered: ${fmt(settlement.loanBalanceRecovered)}`,
      `  Less: Notice Period Recovery: ${fmt(settlement.noticePeriodRecovery)}`,
      `  Total Deductions: ${fmt(deductions)}`,
      `Net Amount Payable: ${fmt(settlement.netSettlementAmount)} (${amountInWords(Math.round(settlement.netSettlementAmount))})`,
      `This settlement is full and final; no further amounts are due to or from either party in respect of your employment.`,
    ],
  };
}

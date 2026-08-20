import {
  CalcType,
  PayFrequency,
  SalaryComponentType,
  StatutoryKey,
} from '@prisma/client';

// Default SalaryComponent rows every organization starts with — covers
// Earnings, Deductions, Statutory Deductions, and Employer Contributions, so
// the Salary Components page and every payslip are never blank on day one.
// Ported verbatim from the old system's seedSalaryComponents.js
// DEFAULT_COMPONENTS.
export interface SalaryComponentDefault {
  name: string;
  code: string;
  type: SalaryComponentType;
  calcType: CalcType;
  displayOrder: number;
  percentageOf?: string;
  percentageValue?: number;
  formula?: string;
  payFrequency?: PayFrequency;
  isActive?: boolean;
  isStatutory?: boolean;
  statutoryKey?: StatutoryKey;
  isEmployerContribution?: boolean;
  includeInGross?: boolean;
  includeInNet?: boolean;
  showOnPayslip?: boolean;
}

export const SALARY_COMPONENT_DEFAULTS: SalaryComponentDefault[] = [
  // Earnings — opt-in per employee
  {
    name: 'Basic Salary',
    code: 'BASIC',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 1,
  },
  {
    name: 'House Rent Allowance',
    code: 'HRA',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.PERCENTAGE,
    percentageOf: 'BASIC',
    percentageValue: 40,
    displayOrder: 2,
  },
  {
    name: 'Dearness Allowance',
    code: 'DA',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 3,
    isActive: false,
  },
  {
    name: 'Special Allowance',
    code: 'SPECIAL_ALLOWANCE',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 4,
  },
  {
    name: 'Conveyance Allowance',
    code: 'CONVEYANCE',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 5,
  },
  {
    name: 'Medical Allowance',
    code: 'MEDICAL_ALLOWANCE',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 6,
  },
  {
    name: 'Incentive',
    code: 'INCENTIVE',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 7,
  },
  {
    name: 'Commission',
    code: 'COMMISSION',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FIXED,
    displayOrder: 8,
  },
  {
    name: 'Overtime Pay',
    code: 'OVERTIME_PAY',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula: 'ROUND(OT_HOURS * (BASIC / 200), 0)',
    displayOrder: 9,
  },
  {
    name: 'Arrears',
    code: 'ARREARS',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.MANUAL,
    displayOrder: 10,
  },
  {
    name: 'Bonus',
    code: 'BONUS',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.MANUAL,
    isStatutory: true,
    statutoryKey: StatutoryKey.BONUS,
    displayOrder: 11,
  },
  // Manual (per-employee amount, like Bonus/Arrears) rather than a fixed
  // percentage — a variable-pay payout is agreed per employee, not derived
  // from Basic. payFrequency defaults to yearly; HR can change it to
  // quarterly/half_yearly on the Salary Components page.
  {
    name: 'Variable Pay',
    code: 'VARIABLE_PAY',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.MANUAL,
    payFrequency: PayFrequency.YEARLY,
    displayOrder: 12,
  },

  // Deductions — opt-in per employee
  {
    name: 'Loan Recovery',
    code: 'LOAN_RECOVERY',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.MANUAL,
    displayOrder: 20,
  },
  {
    name: 'Advance Recovery',
    code: 'ADVANCE_RECOVERY',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.MANUAL,
    displayOrder: 21,
  },
  {
    name: 'Penalty',
    code: 'PENALTY',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.MANUAL,
    displayOrder: 22,
  },
  {
    name: 'Leave Deduction',
    code: 'LEAVE_DEDUCTION',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.MANUAL,
    displayOrder: 23,
  },

  // Statutory deductions — auto-apply once enabled in Payroll Settings /
  // Statutory Compliance Center
  {
    name: 'Provident Fund',
    code: 'PF',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.FORMULA,
    formula: 'ROUND(MIN(BASIC, PF_WAGE_CEILING) * PF_EMPLOYEE_RATE / 100, 0)',
    isStatutory: true,
    statutoryKey: StatutoryKey.PF,
    displayOrder: 30,
  },
  {
    name: 'ESI',
    code: 'ESI',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.FORMULA,
    formula:
      'IF(GROSS_EARNINGS <= ESI_WAGE_CEILING, ROUND(GROSS_EARNINGS * ESI_EMPLOYEE_RATE / 100, 0), 0)',
    isStatutory: true,
    statutoryKey: StatutoryKey.ESI,
    displayOrder: 31,
  },
  {
    name: 'Professional Tax',
    code: 'PT',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.FORMULA,
    formula:
      'IF(GROSS_EARNINGS <= PT_SLAB1_UPTO, PT_SLAB1_AMOUNT, IF(GROSS_EARNINGS <= PT_SLAB2_UPTO, PT_SLAB2_AMOUNT, PT_SLAB3_AMOUNT))',
    isStatutory: true,
    statutoryKey: StatutoryKey.PT,
    displayOrder: 32,
  },
  {
    name: 'Labour Welfare Fund',
    code: 'LWF',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.FORMULA,
    formula: 'LWF_EMPLOYEE_AMOUNT',
    isStatutory: true,
    statutoryKey: StatutoryKey.LWF,
    displayOrder: 33,
  },
  {
    name: 'Income Tax (TDS)',
    code: 'INCOME_TAX',
    type: SalaryComponentType.DEDUCTION,
    calcType: CalcType.MANUAL,
    isStatutory: true,
    statutoryKey: StatutoryKey.INCOME_TAX,
    displayOrder: 34,
  },

  // Employer contributions — never deducted from the employee, added to CTC
  {
    name: 'Employer PF Contribution',
    code: 'PF_EMPLOYER',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula: 'ROUND(MIN(BASIC, PF_WAGE_CEILING) * PF_EMPLOYER_RATE / 100, 0)',
    isStatutory: true,
    statutoryKey: StatutoryKey.PF,
    isEmployerContribution: true,
    includeInGross: false,
    includeInNet: false,
    showOnPayslip: true,
    displayOrder: 40,
  },
  {
    name: 'Employer ESI Contribution',
    code: 'ESI_EMPLOYER',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula:
      'IF(GROSS_EARNINGS <= ESI_WAGE_CEILING, ROUND(GROSS_EARNINGS * ESI_EMPLOYER_RATE / 100, 0), 0)',
    isStatutory: true,
    statutoryKey: StatutoryKey.ESI,
    isEmployerContribution: true,
    includeInGross: false,
    includeInNet: false,
    displayOrder: 41,
  },
  {
    name: 'Employer LWF Contribution',
    code: 'LWF_EMPLOYER',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula: 'LWF_EMPLOYER_AMOUNT',
    isStatutory: true,
    statutoryKey: StatutoryKey.LWF,
    isEmployerContribution: true,
    includeInGross: false,
    includeInNet: false,
    displayOrder: 42,
  },
  {
    name: 'Employer NPS Contribution',
    code: 'NPS_EMPLOYER',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula: 'PERCENT(BASIC, NPS_EMPLOYER_RATE)',
    isStatutory: true,
    statutoryKey: StatutoryKey.NPS,
    isEmployerContribution: true,
    includeInGross: false,
    includeInNet: false,
    displayOrder: 43,
  },
  {
    name: 'Gratuity (Accrual)',
    code: 'GRATUITY_ACCRUAL',
    type: SalaryComponentType.EARNING,
    calcType: CalcType.FORMULA,
    formula: 'PERCENT(BASIC, GRATUITY_RATE)',
    isStatutory: true,
    statutoryKey: StatutoryKey.GRATUITY,
    isEmployerContribution: true,
    includeInGross: false,
    includeInNet: false,
    displayOrder: 44,
  },
];

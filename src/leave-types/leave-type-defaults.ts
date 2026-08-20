import { AccrualFrequency, AllocationType, Gender } from '@prisma/client';

// Default LeaveType rows every organization starts with — covers the
// statutory/common Indian leave types, ported verbatim from the old
// system's seedLeaveTypes.js DEFAULTS. Deliberately excludes a few things
// that aren't actually leave-balance items in this data model: Optional/
// Restricted Holiday belong to the Holiday Calendar (Holidays module,
// type: 'optional'), not a leave an employee applies for and consumes;
// Work From Home / On Duty are attendance statuses, not leave.
export interface LeaveTypeDefault {
  code: string;
  name: string;
  description: string;
  color: string;
  isPaid: boolean;
  displayOrder: number;
  allocationType: AllocationType;
  annualQuota?: number;
  accrualFrequency?: AccrualFrequency;
  prorateOnJoining?: boolean;
  applicableGenders?: Gender[];
  applicableEmployeeTypes?: string[];
  minServiceMonths?: number;
  documentsRequired?: boolean;
  documentRequiredAfterDays?: number;
  rules: Record<string, unknown>;
  carryForward?: {
    allowed: boolean;
    maxDays: number;
    expiryMonths: number | null;
  };
  encashment?: {
    allowed: boolean;
    maxDaysPerYear: number;
    minBalanceToRetain: number;
  };
}

// Mirrors the LeaveType.rules column's own Prisma-level @default exactly.
// Each entry below only lists what it deliberately overrides — the DB
// write is not a JSON merge, so every field not explicitly present here
// (allowFutureDated in particular, since applying for leave in the future
// is the normal case) has to come from an explicit spread of this base,
// or it's silently lost rather than falling back to the column default.
export const DEFAULT_RULES = {
  minDurationDays: 0.5,
  maxDurationDays: null,
  noticePeriodDays: 0,
  allowBackdated: false,
  maxBackdateDays: 0,
  allowFutureDated: true,
  maxAdvanceDays: null,
  allowHalfDay: true,
  sandwichLeaveApplies: false,
  restrictPrefixSuffixHoliday: false,
  maxConsecutiveDays: null,
  minGapBetweenRequestsDays: 0,
};

export const LEAVE_TYPE_DEFAULTS: LeaveTypeDefault[] = [
  {
    code: 'EL',
    name: 'Earned Leave',
    description: 'Annual earned/privilege leave.',
    color: '#3b82f6',
    isPaid: true,
    displayOrder: 1,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 18,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: true,
    rules: {
      minDurationDays: 0.5,
      allowHalfDay: true,
      noticePeriodDays: 2,
      allowFutureDated: true,
    },
    carryForward: { allowed: true, maxDays: 10, expiryMonths: 12 },
    encashment: { allowed: true, maxDaysPerYear: 10, minBalanceToRetain: 5 },
  },
  {
    code: 'LWP',
    name: 'Leave Without Pay',
    description: 'Unpaid leave, unlimited allocation.',
    color: '#ef4444',
    isPaid: false,
    displayOrder: 2,
    allocationType: AllocationType.UNLIMITED,
    rules: {
      minDurationDays: 0.5,
      allowHalfDay: true,
      allowBackdated: true,
      maxBackdateDays: 30,
    },
  },
  {
    code: 'COMPOFF',
    name: 'Comp-Off',
    description: 'Compensatory off for working a weekend/holiday.',
    color: '#8b5cf6',
    isPaid: true,
    displayOrder: 3,
    allocationType: AllocationType.NONE,
    rules: { minDurationDays: 0.5, allowHalfDay: true },
  },
  {
    code: 'SL',
    name: 'Sick Leave',
    description: 'Medical/sick leave.',
    color: '#f59e0b',
    isPaid: true,
    displayOrder: 4,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 12,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: true,
    rules: {
      minDurationDays: 0.5,
      allowHalfDay: true,
      allowBackdated: true,
      maxBackdateDays: 3,
    },
    documentsRequired: true,
    documentRequiredAfterDays: 2,
  },
  {
    code: 'CL',
    name: 'Casual Leave',
    description: 'Short-notice casual leave.',
    color: '#10b981',
    isPaid: true,
    displayOrder: 5,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 12,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: true,
    rules: {
      minDurationDays: 0.5,
      maxConsecutiveDays: 3,
      allowHalfDay: true,
      noticePeriodDays: 1,
    },
  },
  {
    code: 'ML',
    name: 'Maternity Leave',
    description: 'Statutory maternity leave (Maternity Benefit Act).',
    color: '#ec4899',
    isPaid: true,
    displayOrder: 6,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 182,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    applicableGenders: [Gender.FEMALE],
    rules: { minDurationDays: 1, allowHalfDay: false, noticePeriodDays: 30 },
    documentsRequired: true,
  },
  {
    code: 'PTL',
    name: 'Paternity Leave',
    description: 'Leave for new fathers.',
    color: '#0ea5e9',
    isPaid: true,
    displayOrder: 7,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 15,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    applicableGenders: [Gender.MALE],
    rules: { minDurationDays: 1, allowHalfDay: false, noticePeriodDays: 7 },
  },
  {
    code: 'ADL',
    name: 'Adoption Leave',
    description: 'Leave following the legal adoption of a child.',
    color: '#a855f7',
    isPaid: true,
    displayOrder: 8,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 90,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    rules: { minDurationDays: 1, allowHalfDay: false, noticePeriodDays: 15 },
    documentsRequired: true,
  },
  {
    code: 'BL',
    name: 'Bereavement Leave',
    description: 'Leave following the death of an immediate family member.',
    color: '#64748b',
    isPaid: true,
    displayOrder: 9,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 5,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    rules: {
      minDurationDays: 0.5,
      allowHalfDay: true,
      allowBackdated: true,
      maxBackdateDays: 7,
    },
  },
  {
    code: 'MRL',
    name: 'Marriage Leave',
    description: "Leave for the employee's own wedding.",
    color: '#f43f5e',
    isPaid: true,
    displayOrder: 10,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 5,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    rules: { minDurationDays: 1, allowHalfDay: false, noticePeriodDays: 15 },
  },
  {
    code: 'STL',
    name: 'Study Leave',
    description: 'Leave for academic/professional courses or exams.',
    color: '#14b8a6',
    isPaid: false,
    displayOrder: 11,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 10,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    minServiceMonths: 12,
    rules: { minDurationDays: 0.5, allowHalfDay: true, noticePeriodDays: 15 },
    documentsRequired: true,
  },
  {
    code: 'SBL',
    name: 'Sabbatical Leave',
    description: 'Extended unpaid leave for long-tenured employees.',
    color: '#78716c',
    isPaid: false,
    displayOrder: 12,
    allocationType: AllocationType.UNLIMITED,
    minServiceMonths: 36,
    rules: { minDurationDays: 30, allowHalfDay: false, noticePeriodDays: 60 },
  },
  {
    code: 'SPL',
    name: 'Special Leave',
    description:
      'HR-granted leave for situations not covered by another leave type.',
    color: '#eab308',
    isPaid: true,
    displayOrder: 13,
    allocationType: AllocationType.NONE,
    rules: { minDurationDays: 0.5, allowHalfDay: true },
  },
  {
    // "Probation Leave" needs no dedicated model — it's a normal LeaveType
    // restricted to probation-tenure employees via applicableEmployeeTypes,
    // same mechanism every other leave type already uses for eligibility.
    code: 'PRL',
    name: 'Probation Leave',
    description: 'Leave available to employees while on probation.',
    color: '#22c55e',
    isPaid: true,
    displayOrder: 14,
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 3,
    accrualFrequency: AccrualFrequency.YEARLY,
    prorateOnJoining: false,
    applicableEmployeeTypes: ['probation'],
    rules: { minDurationDays: 0.5, allowHalfDay: true, noticePeriodDays: 1 },
    carryForward: { allowed: false, maxDays: 0, expiryMonths: null },
    encashment: { allowed: false, maxDaysPerYear: 0, minBalanceToRetain: 0 },
  },
];

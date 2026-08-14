import { TimelineCategory } from '@prisma/client';

// Canonical Employee Timeline event registry — ported verbatim from the
// old backend's utils/timeline.js EVENT_META. Every service that changes
// something worth showing on the 360° Employee Timeline calls
// EmployeeTimelineService.logEvent() with an eventKey from here, right
// next to the existing AuditLogService.log() call for that same action —
// same code path, same data, so Timeline and Audit Log can never drift
// apart.

export interface TimelineEventMeta {
  category: TimelineCategory;
  title: string;
}

export const EVENT_META: Record<string, TimelineEventMeta> = {
  // Recruitment
  EMPLOYEE_RECORD_CREATED: {
    category: 'RECRUITMENT',
    title: 'Employee Record Created',
  },
  OFFER_LETTER_GENERATED: {
    category: 'RECRUITMENT',
    title: 'Offer Letter Generated',
  },
  OFFER_ACCEPTED: { category: 'RECRUITMENT', title: 'Offer Accepted' },
  JOINING_CONFIRMED: { category: 'RECRUITMENT', title: 'Joining Confirmed' },
  // Employment
  JOINED_COMPANY: { category: 'EMPLOYMENT', title: 'Joined Company' },
  ONBOARDING_STARTED: { category: 'EMPLOYMENT', title: 'Onboarding Started' },
  DOCUMENTS_SUBMITTED: { category: 'EMPLOYMENT', title: 'Documents Submitted' },
  DOCUMENTS_VERIFIED: { category: 'EMPLOYMENT', title: 'Documents Verified' },
  PROBATION_STARTED: { category: 'EMPLOYMENT', title: 'Probation Started' },
  PROBATION_EXTENDED: { category: 'EMPLOYMENT', title: 'Probation Extended' },
  EMPLOYMENT_CONFIRMED: {
    category: 'EMPLOYMENT',
    title: 'Employment Confirmed',
  },
  EMPLOYMENT_ON_HOLD: { category: 'EMPLOYMENT', title: 'Employment On Hold' },
  EMPLOYEE_UPDATED: {
    category: 'EMPLOYMENT',
    title: 'Employee Record Updated',
  },
  // Organization
  DEPARTMENT_CHANGED: { category: 'ORGANIZATION', title: 'Department Changed' },
  DESIGNATION_CHANGED: {
    category: 'ORGANIZATION',
    title: 'Designation Changed',
  },
  ROLE_CHANGED: { category: 'ORGANIZATION', title: 'Role Changed' },
  REPORTING_MANAGER_CHANGED: {
    category: 'ORGANIZATION',
    title: 'Reporting Manager Changed',
  },
  WORK_LOCATION_CHANGED: {
    category: 'ORGANIZATION',
    title: 'Work Location Changed',
  },
  BRANCH_CHANGED: { category: 'ORGANIZATION', title: 'Branch Changed' },
  COST_CENTER_CHANGED: {
    category: 'ORGANIZATION',
    title: 'Cost Center Changed',
  },
  // Payroll
  SALARY_STRUCTURE_ASSIGNED: {
    category: 'PAYROLL',
    title: 'Salary Structure Assigned',
  },
  SALARY_REVISION: { category: 'PAYROLL', title: 'Salary Revision' },
  PAYROLL_TEMPLATE_CHANGED: {
    category: 'PAYROLL',
    title: 'Payroll Template Changed',
  },
  BANK_DETAILS_UPDATED: { category: 'PAYROLL', title: 'Bank Details Updated' },
  TAX_REGIME_CHANGED: { category: 'PAYROLL', title: 'Tax Regime Changed' },
  PAYROLL_PROCESSED: { category: 'PAYROLL', title: 'Payroll Processed' },
  // Attendance & Leave
  ATTENDANCE_REGULARIZED: {
    category: 'ATTENDANCE_LEAVE',
    title: 'Attendance Regularized',
  },
  LEAVE_APPROVED: { category: 'ATTENDANCE_LEAVE', title: 'Leave Approved' },
  LEAVE_REJECTED: { category: 'ATTENDANCE_LEAVE', title: 'Leave Rejected' },
  LEAVE_CANCELLED: { category: 'ATTENDANCE_LEAVE', title: 'Leave Cancelled' },
  COMP_OFF_GRANTED: { category: 'ATTENDANCE_LEAVE', title: 'Comp-Off Granted' },
  // Performance
  PERFORMANCE_REVIEW: { category: 'PERFORMANCE', title: 'Performance Review' },
  PROMOTION: { category: 'PERFORMANCE', title: 'Promotion' },
  DEMOTION: { category: 'PERFORMANCE', title: 'Demotion' },
  AWARD: { category: 'PERFORMANCE', title: 'Award' },
  WARNING_LETTER: { category: 'PERFORMANCE', title: 'Warning Letter' },
  APPRECIATION: { category: 'PERFORMANCE', title: 'Appreciation' },
  // Compliance
  KYC_UPDATED: { category: 'COMPLIANCE', title: 'KYC Updated' },
  PF_UPDATED: { category: 'COMPLIANCE', title: 'PF Updated' },
  ESI_UPDATED: { category: 'COMPLIANCE', title: 'ESI Updated' },
  UAN_UPDATED: { category: 'COMPLIANCE', title: 'UAN Updated' },
  PAN_UPDATED: { category: 'COMPLIANCE', title: 'PAN Updated' },
  AADHAAR_UPDATED: { category: 'COMPLIANCE', title: 'Aadhaar Updated' },
  // Exit
  RESIGNATION_SUBMITTED: { category: 'EXIT', title: 'Resignation Submitted' },
  NOTICE_PERIOD_STARTED: { category: 'EXIT', title: 'Notice Period Started' },
  NOTICE_PERIOD_EXTENDED: { category: 'EXIT', title: 'Notice Period Extended' },
  EXIT_INTERVIEW_COMPLETED: {
    category: 'EXIT',
    title: 'Exit Interview Completed',
  },
  FNF_INITIATED: {
    category: 'EXIT',
    title: 'Full & Final Settlement Initiated',
  },
  FNF_COMPLETED: {
    category: 'EXIT',
    title: 'Full & Final Settlement Completed',
  },
  RELIEVED: { category: 'EXIT', title: 'Relieved' },
  TERMINATED: { category: 'EXIT', title: 'Terminated' },
  ABSCONDED: { category: 'EXIT', title: 'Absconded' },
};

export const TIMELINE_CATEGORIES: { value: TimelineCategory; label: string }[] =
  [
    { value: 'RECRUITMENT', label: 'Recruitment' },
    { value: 'EMPLOYMENT', label: 'Employment' },
    { value: 'ORGANIZATION', label: 'Organization' },
    { value: 'PAYROLL', label: 'Payroll' },
    { value: 'ATTENDANCE_LEAVE', label: 'Attendance & Leave' },
    { value: 'PERFORMANCE', label: 'Performance' },
    { value: 'COMPLIANCE', label: 'Compliance' },
    { value: 'EXIT', label: 'Exit' },
  ];

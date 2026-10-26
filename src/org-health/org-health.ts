// Purpose: the rules behind the Organization health view - how much of the company's setup is done, which settings contradict each
//   other, and which people who have left still lead a team or a department.
// Responsibilities: pure rules over plain counts and values (no database), so the service, the weekly notice and the tests share them.
// Important: a setup item is "done" once there is at least one record; it does not judge quality. A clash is a warning, never an
//   error that blocks saving - the company may have a reason - and each says what to change.
import { isWeeklyOff, type WeeklyOffEntry } from '../attendance/attendance-shift-config';
import { dmyText } from '../payroll/format-date';

export interface SetupCounts {
  workLocations: number;
  workSchedules: number;
  departments: number;
  designations: number;
  leaveTypes: number;
  holidaysThisYear: number;
  salaryComponents: number;
  documentRequirements: number;
  employees: number;
}

export interface SetupItem {
  key: string;
  label: string;
  done: boolean;
  // The screen that fixes it.
  link: string;
}

export interface SetupStatus {
  percent: number;
  done: number;
  total: number;
  items: SetupItem[];
}

export function buildSetupStatus(c: SetupCounts): SetupStatus {
  const items: SetupItem[] = [
    { key: 'workLocations', label: 'Add a work location', done: c.workLocations > 0, link: '/work-locations' },
    { key: 'workSchedules', label: 'Set a work schedule', done: c.workSchedules > 0, link: '/work-schedules' },
    { key: 'departments', label: 'Add departments', done: c.departments > 0, link: '/departments' },
    { key: 'designations', label: 'Add designations', done: c.designations > 0, link: '/designations' },
    { key: 'leaveTypes', label: 'Set up leave types', done: c.leaveTypes > 0, link: '/leave-types' },
    { key: 'holidays', label: 'Add this year\'s holidays', done: c.holidaysThisYear > 0, link: '/holidays' },
    { key: 'salaryComponents', label: 'Add salary components', done: c.salaryComponents > 0, link: '/salary-components' },
    { key: 'documentRequirements', label: 'Choose the documents employees must upload', done: c.documentRequirements > 0, link: '/document-requirements' },
    { key: 'employees', label: 'Add your first employees', done: c.employees > 1, link: '/employees' },
  ];
  const done = items.filter((i) => i.done).length;
  return { percent: Math.round((done / items.length) * 100), done, total: items.length, items };
}

export interface SettingsFacts {
  // This month's processing and payment dates, resolved from the payroll calendar (YYYY-MM-DD).
  processingDate: string;
  paymentDate: string;
  // True when the day is a fixed calendar day (1-31) rather than "last working day" - only a fixed day can land on a weekly off.
  processingFixed: boolean;
  paymentFixed: boolean;
  weeklyOffs: WeeklyOffEntry[];
  pfEnabled: boolean;
  esiEnabled: boolean;
  ptEnabled: boolean;
  epfoEstablishmentCode: string | null;
  esicEmployerCode: string | null;
  ptRegistrationNumber: string | null;
  taxRegimeEmployeeChange: boolean;
  taxRegimeCutoffMonth: number | null;
}

export interface SettingsClash {
  key: string;
  title: string;
  // What is wrong and what to change.
  detail: string;
  // The screen to change it on.
  link: string;
}

const blank = (v: string | null | undefined) => !v || !v.trim();

export function findSettingsClashes(f: SettingsFacts): SettingsClash[] {
  const out: SettingsClash[] = [];
  if (f.paymentDate < f.processingDate) {
    out.push({
      key: 'pay-before-processing',
      title: 'Salary is paid before payroll is processed',
      detail: `Salary is paid on ${dmyText(f.paymentDate)}, but payroll is processed on ${dmyText(f.processingDate)}. Move the payment day after the processing day.`,
      link: '/payroll-settings',
    });
  }
  if (f.processingFixed && isWeeklyOff(f.processingDate, f.weeklyOffs)) {
    out.push({
      key: 'processing-on-weekly-off',
      title: 'Payroll processing day falls on a weekly off',
      detail: `Payroll is processed on ${dmyText(f.processingDate)}, which is a weekly off in the work schedule. Pick a working day, or use "last working day".`,
      link: '/payroll-settings',
    });
  }
  if (f.paymentFixed && isWeeklyOff(f.paymentDate, f.weeklyOffs)) {
    out.push({
      key: 'payment-on-weekly-off',
      title: 'Salary payment day falls on a weekly off',
      detail: `Salary is paid on ${dmyText(f.paymentDate)}, which is a weekly off in the work schedule. Pick a working day, or use "last working day".`,
      link: '/payroll-settings',
    });
  }
  if (f.pfEnabled && blank(f.epfoEstablishmentCode)) {
    out.push({ key: 'pf-no-code', title: 'PF is on but the EPFO establishment code is missing', detail: 'The PF return (ECR) needs the establishment code. Add it under Organization > Registration.', link: '/organization-settings' });
  }
  if (f.esiEnabled && blank(f.esicEmployerCode)) {
    out.push({ key: 'esi-no-code', title: 'ESI is on but the ESIC employer code is missing', detail: 'The ESIC return needs the employer code. Add it under Organization > Registration.', link: '/organization-settings' });
  }
  if (f.ptEnabled && blank(f.ptRegistrationNumber)) {
    out.push({ key: 'pt-no-number', title: 'Professional Tax is on but the PT registration number is missing', detail: 'Add the PT registration number under Organization > Registration.', link: '/organization-settings' });
  }
  if (!f.taxRegimeEmployeeChange && f.taxRegimeCutoffMonth !== null) {
    out.push({
      key: 'regime-cutoff-unused',
      title: 'A tax regime change deadline is set but employees cannot change regime',
      detail: 'Employees are not allowed to change their tax regime, so the deadline month has no effect. Allow the change, or clear the deadline.',
      link: '/payroll-settings',
    });
  }
  return out;
}

export interface LeaverTeam {
  managerId: string;
  name: string;
  code: string;
  reports: { id: string; name: string }[];
}

export interface LeaverDepartment {
  departmentId: string;
  name: string;
  headId: string;
  headName: string;
}

/** Someone no longer working here: deactivated, a final exit status, or past their last working day. */
export function hasLeft(p: { isActive: boolean; employmentStatus: string; exitDate: string | null }, today: string): boolean {
  return !p.isActive || ['RELEASED', 'TERMINATED', 'ABSCONDED'].includes(p.employmentStatus) || (!!p.exitDate && p.exitDate < today);
}

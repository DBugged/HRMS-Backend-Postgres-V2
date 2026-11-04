// Purpose: the Admin-set overtime policy (Org Settings > General Settings > Overtime) and the pure rules built on it.
// Responsibilities: reads the policy from orgPayrollAttendancePrefs.overtimePolicy, rounds logged hours, and checks a
//   request against the claim window and the daily / monthly caps.
// Important: every field is optional and a missing field means "no restriction" (caps, window) or today's
//   behaviour (minimum 30 minutes, no rounding, employees may log and punches may suggest), so an org that never opens
//   the card behaves exactly as before.
import type { Prisma } from '@prisma/client';

export type OvertimeCapMode = 'BLOCK' | 'WARN';
export type OvertimeCreationMode = 'BOTH' | 'SELF' | 'AUTO';
export type OvertimeRoundingMode = 'DOWN' | 'NEAREST' | 'UP';

export type OvertimeCompensationMode = 'ANY' | 'PAY' | 'COMP_OFF';
export type OvertimeAutoApprove = 'COMPANY' | 'ON' | 'OFF';
export type OvertimeApprovalLevel = 'MANAGER' | 'HR';
export type OvertimeDayKey = 'REGULAR' | 'WEEKEND' | 'HOLIDAY' | 'NIGHT';
// A day type can ask for more than the policy as a whole (e.g. no minimum on a holiday, 9 hours on a working day).
export interface OvertimeDayRule {
  minMinutes?: number | null;
  minWorkedHours?: number | null;
}

export interface OvertimePolicy {
  // false = overtime does not apply to these people at all (managers, senior staff...). Set through a rule set.
  eligible: boolean;
  // Overtime counts only from this many minutes after the shift ends (0 = from the shift end). Working days only.
  startAfterMinutes: number;
  maxHoursPerQuarter: number | null;
  // How weekend / holiday work may be compensated: either, pay only (days of pay or the hourly rate), or comp-off only.
  compensationMode: OvertimeCompensationMode;
  // COMPANY = the company's auto-approval rule; ON / OFF = this rule set decides on its own.
  autoApprove: OvertimeAutoApprove;
  autoApproveMonthlyCapHours: number | null;
  // MANAGER = the reporting manager (then HR) reviews; HR = only HR / Admin may decide.
  approvalLevel: OvertimeApprovalLevel;
  // Overtime that ends inside this window is recorded as night overtime on its own (both set = on).
  nightStart: string | null;
  nightEnd: string | null;
  dayRules: Partial<Record<OvertimeDayKey, OvertimeDayRule>>;
  // Overtime shorter than this is not counted (also the punch-out suggestion threshold).
  minMinutes: number;
  // 0 = no rounding.
  roundingMinutes: 0 | 15 | 30 | 60;
  roundingMode: OvertimeRoundingMode;
  // Hours that must be worked in the day (from the punches) before any overtime counts for it; null = no requirement.
  minWorkedHours: number | null;
  maxHoursPerDay: number | null;
  maxHoursPerMonth: number | null;
  capMode: OvertimeCapMode;
  // Days after the date within which overtime may still be requested; null = no limit.
  claimWithinDays: number | null;
  creationMode: OvertimeCreationMode;
}

export const DEFAULT_OVERTIME_POLICY: OvertimePolicy = {
  eligible: true,
  startAfterMinutes: 0,
  maxHoursPerQuarter: null,
  compensationMode: 'ANY',
  autoApprove: 'COMPANY',
  autoApproveMonthlyCapHours: null,
  approvalLevel: 'MANAGER',
  nightStart: null,
  nightEnd: null,
  dayRules: {},
  minMinutes: 30,
  roundingMinutes: 0,
  roundingMode: 'DOWN',
  minWorkedHours: null,
  maxHoursPerDay: null,
  maxHoursPerMonth: null,
  capMode: 'BLOCK',
  claimWithinDays: null,
  creationMode: 'BOTH',
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function resolveOvertimePolicy(prefs: unknown): OvertimePolicy {
  const raw = ((prefs ?? {}) as { overtimePolicy?: Record<string, unknown> })
    .overtimePolicy;
  const p = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_OVERTIME_POLICY;
  const hhmm = (v: unknown) =>
    typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
  const dayRules: OvertimePolicy['dayRules'] = {};
  const rawDay = (p.dayRules ?? {}) as Record<string, Record<string, unknown>>;
  for (const k of ['REGULAR', 'WEEKEND', 'HOLIDAY', 'NIGHT'] as const) {
    const r = rawDay[k];
    if (r && typeof r === 'object') {
      dayRules[k] = {
        minMinutes: num(r.minMinutes),
        minWorkedHours: num(r.minWorkedHours),
      };
    }
  }
  return {
    eligible: p.eligible !== false,
    startAfterMinutes: num(p.startAfterMinutes) ?? d.startAfterMinutes,
    maxHoursPerQuarter: num(p.maxHoursPerQuarter),
    compensationMode: (['ANY', 'PAY', 'COMP_OFF'].includes(
      p.compensationMode as string,
    )
      ? p.compensationMode
      : d.compensationMode) as OvertimeCompensationMode,
    autoApprove: (['COMPANY', 'ON', 'OFF'].includes(p.autoApprove as string)
      ? p.autoApprove
      : d.autoApprove) as OvertimeAutoApprove,
    autoApproveMonthlyCapHours: num(p.autoApproveMonthlyCapHours),
    approvalLevel: p.approvalLevel === 'HR' ? 'HR' : 'MANAGER',
    nightStart: hhmm(p.nightStart),
    nightEnd: hhmm(p.nightEnd),
    dayRules,
    minMinutes: num(p.minMinutes) ?? d.minMinutes,
    roundingMinutes: ([0, 15, 30, 60].includes(p.roundingMinutes as number)
      ? p.roundingMinutes
      : d.roundingMinutes) as OvertimePolicy['roundingMinutes'],
    roundingMode: (['DOWN', 'NEAREST', 'UP'].includes(p.roundingMode as string)
      ? p.roundingMode
      : d.roundingMode) as OvertimeRoundingMode,
    minWorkedHours: num(p.minWorkedHours),
    maxHoursPerDay: num(p.maxHoursPerDay),
    maxHoursPerMonth: num(p.maxHoursPerMonth),
    capMode: p.capMode === 'WARN' ? 'WARN' : 'BLOCK',
    claimWithinDays: num(p.claimWithinDays),
    creationMode: (['BOTH', 'SELF', 'AUTO'].includes(p.creationMode as string)
      ? p.creationMode
      : d.creationMode) as OvertimeCreationMode,
  };
}

export async function getOvertimePolicy(
  db: Pick<Prisma.TransactionClient, 'organization'>,
  organizationId: string,
): Promise<OvertimePolicy> {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { orgPayrollAttendancePrefs: true },
  });
  return resolveOvertimePolicy(org?.orgPayrollAttendancePrefs);
}

// Hours rounded to the policy's step, to 2 decimals.
export function roundOvertimeHours(
  hours: number,
  policy: OvertimePolicy,
): number {
  if (!policy.roundingMinutes) return Math.round(hours * 100) / 100;
  const step = policy.roundingMinutes / 60;
  const units = hours / step;
  const rounded =
    policy.roundingMode === 'UP'
      ? Math.ceil(units - 1e-9)
      : policy.roundingMode === 'NEAREST'
        ? Math.round(units)
        : Math.floor(units + 1e-9);
  return Math.round(rounded * step * 100) / 100;
}

// A request's problem against the Admin's caps, as { block } (rejected) or { warn } (allowed, tell the person).
// `usedToday` / `usedThisMonth` are hours already logged (pending or approved) excluding this request.
export function overtimeCapProblem(
  policy: OvertimePolicy,
  hours: number,
  usedToday: number,
  usedThisMonth: number,
  usedThisQuarter = 0,
): { block?: string; warn?: string } {
  const problems: string[] = [];
  if (
    policy.maxHoursPerDay !== null &&
    usedToday + hours > policy.maxHoursPerDay + 1e-9
  ) {
    problems.push(
      `Overtime is limited to ${policy.maxHoursPerDay} hour(s) per day.`,
    );
  }
  if (
    policy.maxHoursPerMonth !== null &&
    usedThisMonth + hours > policy.maxHoursPerMonth + 1e-9
  ) {
    problems.push(
      `Overtime is limited to ${policy.maxHoursPerMonth} hour(s) per month (${Math.round(usedThisMonth * 100) / 100} already used).`,
    );
  }
  if (
    policy.maxHoursPerQuarter !== null &&
    usedThisQuarter + hours > policy.maxHoursPerQuarter + 1e-9
  ) {
    problems.push(
      `Overtime is limited to ${policy.maxHoursPerQuarter} hour(s) per quarter (${Math.round(usedThisQuarter * 100) / 100} already used).`,
    );
  }
  if (problems.length === 0) return {};
  const message = problems.join(' ');
  return policy.capMode === 'WARN' ? { warn: message } : { block: message };
}

// Whole days between the overtime date (YYYY-MM-DD) and today (YYYY-MM-DD).
export function daysSince(date: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

// The minimums for one kind of overtime: the day-type rule where there is one, else the policy's own.
export function thresholdsFor(
  policy: OvertimePolicy,
  type: OvertimeDayKey,
): { minMinutes: number; minWorkedHours: number | null } {
  const r = policy.dayRules[type];
  return {
    minMinutes: r?.minMinutes ?? policy.minMinutes,
    minWorkedHours: r?.minWorkedHours ?? policy.minWorkedHours,
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Is this wall-clock time (HH:MM) inside the night window? The window may run past midnight (22:00 to 06:00).
export function inNightWindow(policy: OvertimePolicy, hhmm: string): boolean {
  if (!policy.nightStart || !policy.nightEnd) return false;
  const t = toMinutes(hhmm);
  const s = toMinutes(policy.nightStart);
  const e = toMinutes(policy.nightEnd);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

// First and last day (YYYY-MM-DD) of the calendar quarter holding `date`.
export function quarterRange(date: string): { from: string; to: string } {
  const y = Number(date.slice(0, 4));
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3);
  const lastMonth = q * 3 + 3;
  const lastDay = new Date(Date.UTC(y, lastMonth, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(q * 3 + 1)}-01`, to: `${y}-${pad(lastMonth)}-${pad(lastDay)}` };
}

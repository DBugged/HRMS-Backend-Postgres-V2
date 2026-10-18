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

export interface OvertimePolicy {
  // Overtime shorter than this is not counted (also the punch-out suggestion threshold).
  minMinutes: number;
  // 0 = no rounding.
  roundingMinutes: 0 | 15 | 30 | 60;
  roundingMode: OvertimeRoundingMode;
  maxHoursPerDay: number | null;
  maxHoursPerMonth: number | null;
  capMode: OvertimeCapMode;
  // Days after the date within which overtime may still be requested; null = no limit.
  claimWithinDays: number | null;
  creationMode: OvertimeCreationMode;
}

export const DEFAULT_OVERTIME_POLICY: OvertimePolicy = {
  minMinutes: 30,
  roundingMinutes: 0,
  roundingMode: 'DOWN',
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
  return {
    minMinutes: num(p.minMinutes) ?? d.minMinutes,
    roundingMinutes: ([0, 15, 30, 60].includes(p.roundingMinutes as number)
      ? p.roundingMinutes
      : d.roundingMinutes) as OvertimePolicy['roundingMinutes'],
    roundingMode: (['DOWN', 'NEAREST', 'UP'].includes(p.roundingMode as string)
      ? p.roundingMode
      : d.roundingMode) as OvertimeRoundingMode,
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
  if (problems.length === 0) return {};
  const message = problems.join(' ');
  return policy.capMode === 'WARN' ? { warn: message } : { block: message };
}

// Whole days between the overtime date (YYYY-MM-DD) and today (YYYY-MM-DD).
export function daysSince(date: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

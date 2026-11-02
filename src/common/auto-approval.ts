// Purpose: the company's optional auto-approval rules for overtime, comp-off and reimbursement requests.
// Responsibilities: reads the rules from the organisation's policies (all OFF by default), decides whether one request qualifies,
//   and finds the Admin the automatic decision is recorded under.
// Important: pure rules - the services call the normal review path afterwards, so history, audit, notifications and payroll
//   effects are identical to a manual approval. A request that does not qualify simply stays pending for a person to decide.
import { Role, type User } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

export interface AutoApprovalRules {
  overtime: { on: boolean; monthlyCapHours: number };
  compOff: { on: boolean; maxDays: number };
  reimbursement: { on: boolean; maxAmount: number };
}

const positive = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

export function readAutoApproval(policies: unknown): AutoApprovalRules {
  const p = (policies ?? {}) as Record<string, unknown>;
  return {
    overtime: { on: p.autoApproveOvertime === true, monthlyCapHours: positive(p.autoApproveOvertimeMonthlyCapHours, 0) },
    compOff: { on: p.autoApproveCompOff === true, maxDays: positive(p.autoApproveCompOffMaxDays, 1) },
    reimbursement: { on: p.autoApproveReimbursement === true, maxAmount: positive(p.autoApproveReimbursementMaxAmount, 0) },
  };
}

/** Overtime qualifies when this record plus the month's earlier overtime stays within the monthly cap (a cap of 0 approves nothing). */
export function overtimeQualifies(r: AutoApprovalRules['overtime'], hours: number, usedThisMonth: number): boolean {
  return r.on && r.monthlyCapHours > 0 && usedThisMonth + hours <= r.monthlyCapHours;
}

export function compOffQualifies(r: AutoApprovalRules['compOff'], daysEarned: number): boolean {
  return r.on && daysEarned > 0 && daysEarned <= r.maxDays;
}

/** A claim qualifies when it is within the amount limit and carries a receipt (a limit of 0 approves nothing). */
export function reimbursementQualifies(r: AutoApprovalRules['reimbursement'], amount: number, hasReceipt: boolean): boolean {
  return r.on && r.maxAmount > 0 && amount <= r.maxAmount && hasReceipt;
}

export async function loadAutoApproval(prisma: ExtendedPrismaClient, organizationId: string): Promise<AutoApprovalRules> {
  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { policies: true } });
  return readAutoApproval(org?.policies);
}

/** The company's first active Admin other than the requester (the decision is recorded under them), or null if there is none. */
export async function findAutoApprover(prisma: ExtendedPrismaClient, organizationId: string, requesterId: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { organizationId, isActive: true, role: Role.ADMIN, id: { not: requesterId } },
    orderBy: { createdAt: 'asc' },
  });
}

export const AUTO_APPROVAL_NOTE = 'Approved automatically under the company policy.';

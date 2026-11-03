import { isManagerOf, managerIdsOf } from './managers';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import type { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { todayInOrgTz } from './org-date';
import { collectReportingChain } from '../employees/employee-query-scope';

interface DeptScopeActor {
  id: string;
  role: Role;
  departmentId: string | null;
}

// Who a reviewer looks after, or null for "everyone". The assignment is Department head (Organization > Departments):
// - ADMIN sees everyone.
// - HR sees the departments they head; an HR user who heads none sees everyone (until assigned).
// - MANAGER sees the departments they head. One who heads none sees their own reporting line, plus their own
//   department while that department has no head assigned (once a head is set, only the head sees it).
// - Both always see themself and their reporting chain (direct reports and everyone below), so My Team and the
//   approval lists agree.
// - EMPLOYEE sees only themself.
export async function reviewerScope(
  prisma: ExtendedPrismaClient,
  actor: { id?: string; role: Role },
  organizationId: string,
): Promise<string[] | null> {
  if (actor.role === Role.ADMIN) return null;
  if (!actor.id) return [];
  if (actor.role === Role.EMPLOYEE) return [actor.id];
  const headed = await prisma.department.findMany({
    where: { organizationId, departmentHeadId: actor.id },
    select: { id: true },
  });
  if (actor.role === Role.HR && headed.length === 0) return null;
  const [people, me] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId },
      select: { id: true, departmentId: true, reportingManagerId: true, additionalReportingManagerIds: true },
    }),
    prisma.user.findFirst({
      where: { id: actor.id, organizationId },
      select: { department: { select: { id: true, departmentHeadId: true } } },
    }),
  ]);
  const headedIds = new Set(headed.map((d) => d.id));
  if (actor.role === Role.MANAGER && headed.length === 0 && me?.department && !me.department.departmentHeadId) {
    headedIds.add(me.department.id);
  }
  const ids = new Set<string>([actor.id, ...collectReportingChain(actor.id, people)]);
  for (const p of people) if (p.departmentId && headedIds.has(p.departmentId)) ids.add(p.id);
  return [...ids];
}

// Employee ids a scoped reviewer's list/query endpoints must be constrained to (see reviewerScope). Kept for the callers
// that only ever pass a MANAGER, who is always scoped; an unscoped actor gets an empty list rather than everyone.
export async function deptScopedEmployeeIds(
  prisma: ExtendedPrismaClient,
  actor: DeptScopeActor,
  organizationId: string,
): Promise<string[]> {
  return (await reviewerScope(prisma, actor, organizationId)) ?? [];
}

// True when the actor may see / act on this employee under reviewerScope.
export async function inReviewerScope(
  prisma: ExtendedPrismaClient,
  actor: { id?: string; role: Role },
  organizationId: string,
  employeeId: string,
): Promise<boolean> {
  const scope = await reviewerScope(prisma, actor, organizationId);
  return scope === null || scope.includes(employeeId);
}

// No one below ADMIN may approve their own request — an HR (or MANAGER)
// reviewing their own leave/comp-off/overtime/reimbursement/document is
// self-approval regardless of department scope, so this runs first, ahead
// of (and independent from) the MANAGER-only department check below. ADMIN
// is exempt: there's no one above an Admin in this hierarchy to review
// their requests instead.
export function assertNotSelfApproval(
  actor: DeptScopeActor,
  targetEmployeeId: string,
): void {
  if (actor.role !== Role.ADMIN && actor.id === targetEmployeeId) {
    throw new ForbiddenException(
      'You cannot approve or review your own request.',
    );
  }
}

// Guards a single-record action (review/approve/view) so a scoped reviewer (see reviewerScope: a MANAGER, or an HR
// user who heads departments) can only act on an employee they look after, and no one but ADMIN can act on their own
// request. EMPLOYEE never reaches this — those actions are self-scoped upstream.
export async function assertManagerDeptScope(
  prisma: ExtendedPrismaClient,
  actor: DeptScopeActor,
  organizationId: string,
  targetEmployeeId: string,
): Promise<void> {
  assertNotSelfApproval(actor, targetEmployeeId);
  if (actor.role === Role.ADMIN || actor.role === Role.EMPLOYEE) return;
  if (!(await inReviewerScope(prisma, actor, organizationId, targetEmployeeId))) {
    throw new ForbiddenException(
      'You can only act on employees in the departments you head or who report to you.',
    );
  }
}

// Same guard as assertManagerDeptScope, but also lets a stand-in reviewer
// act when the target employee's actual reporting manager has an active
// ApprovalDelegation naming the actor — same isActiveDelegate pattern as
// LeavesService.review(), applied to attendance regularization/WFH,
// overtime, and comp-off review paths so delegation works consistently
// across all review actions, not just leaves.
export async function assertManagerScopeOrDelegate(
  prisma: ExtendedPrismaClient,
  delegationService: ApprovalDelegationService,
  actor: DeptScopeActor,
  organizationId: string,
  targetEmployeeId: string,
): Promise<void> {
  assertNotSelfApproval(actor, targetEmployeeId);
  // An Admin's requests are decided by an Admin, never by HR or a manager (an Admin has no reporting manager, so
  // nothing falls back to HR).
  if (actor.role !== Role.ADMIN) {
    const targetUser = await prisma.user.findFirst({
      where: { id: targetEmployeeId, organizationId },
      select: { role: true },
    });
    if (targetUser?.role === Role.ADMIN) {
      throw new ForbiddenException(
        "Only an Admin can decide an Admin's request.",
      );
    }
  }
  if (actor.role === Role.ADMIN || actor.role === Role.EMPLOYEE) return;
  const target = await prisma.user.findFirst({
    where: { id: targetEmployeeId, organizationId },
    select: { reportingManagerId: true, additionalReportingManagerIds: true },
  });
  if (!target) {
    throw new ForbiddenException(
      'You can only act on employees in the departments you head or who report to you (or whose manager has delegated to you).',
    );
  }
  // The actual reporting relationship always grants access, independent of department.
  if (isManagerOf(actor.id, target)) return;
  if (await inReviewerScope(prisma, actor, organizationId, targetEmployeeId)) return;

  // A delegate of ANY of the employee's managers (primary or additional) may act for them.
  const managerIds = managerIdsOf(target);
  if (managerIds.length > 0) {
    const org = await prisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    for (const managerId of managerIds) {
      if (await delegationService.isActiveDelegate(managerId, actor.id, organizationId, today)) return;
    }
  }

  throw new ForbiddenException(
    'You can only act on employees in the departments you head or who report to you (or whose manager has delegated to you).',
  );
}

// True when the actor's lists are narrowed to their own people (see reviewerScope) - a MANAGER, or an HR user who heads
// departments. Callers then take the ids from deptScopedEmployeeIds.
export async function isScopedReviewer(
  prisma: ExtendedPrismaClient,
  actor: { id?: string; role: Role },
  organizationId: string,
): Promise<boolean> {
  if (actor.role === Role.ADMIN || actor.role === Role.EMPLOYEE) return false;
  return (await reviewerScope(prisma, actor, organizationId)) !== null;
}

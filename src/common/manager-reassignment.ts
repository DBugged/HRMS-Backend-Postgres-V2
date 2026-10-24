// Purpose: Moves everyone who reports to a manager (as primary OR additional manager) to a replacement manager in one go -
// the "Reassign all reports" action - and the shared guard used wherever an employee gets deactivated — the plain PATCH .../deactivate route,
// the generic PATCH /employees/:id when it flips isActive to false, and offboarding's complete() — so a
// manager (or anyone else who happens to be another active employee's reportingManagerId) can never be
// deactivated leaving direct reports pointing at a manager who can no longer even log in.
// Responsibilities: Finds active direct reports of the employee being deactivated; if none, no-ops. If any
// exist, requires an explicit `reassignManagerId` (a validated, active, different employee) and reassigns
// every direct report to it in one bulk update, logging a REPORTING_MANAGER_CHANGED timeline event per
// affected employee plus one audit-log entry for the whole batch.
import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { reportsToWhere } from './managers';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import type { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { mapWithConcurrency } from './concurrency';
import type { AuditLogService } from '../audit-log/audit-log.service';

export interface ReassignDeps {
  scopedPrisma: ExtendedPrismaClient;
  timelineService: EmployeeTimelineService;
  auditLogService: AuditLogService;
}

/** Active people who report to this manager, as primary or additional. */
export function activeReportsOf(scopedPrisma: ExtendedPrismaClient, managerId: string, organizationId: string) {
  return scopedPrisma.user.findMany({
    where: { organizationId, isActive: true, ...reportsToWhere(managerId) },
    select: { id: true, name: true, reportingManagerId: true, additionalReportingManagerIds: true },
  });
}

/**
 * Moves every active report of `fromManagerId` to `toManagerId`: people it was the primary manager of get the new primary,
 * people it was an additional manager of get the new person in its place (no duplicates). Logs a timeline event for each
 * and one audit entry. Returns who was moved. The replacement must be an active Admin, HR or Manager and must not
 * report to the person leaving (that would loop).
 */
export async function reassignReports(
  deps: ReassignDeps,
  fromManagerId: string,
  toManagerId: string,
  organizationId: string,
  actorId: string,
): Promise<{ count: number; names: string[] }> {
  const { scopedPrisma, timelineService, auditLogService } = deps;
  if (toManagerId === fromManagerId) {
    throw new BadRequestException('Pick a different manager to move the reports to.');
  }
  const newManager = await scopedPrisma.user.findFirst({ where: { id: toManagerId, organizationId, isActive: true } });
  if (!newManager) {
    throw new BadRequestException('The selected replacement manager was not found, or is inactive.');
  }
  if (newManager.role === Role.EMPLOYEE) {
    throw new BadRequestException('The replacement must be an Admin, HR or Manager.');
  }
  const reports = await activeReportsOf(scopedPrisma, fromManagerId, organizationId);
  if (reports.length === 0) return { count: 0, names: [] };
  if (reports.some((r) => r.id === toManagerId)) {
    throw new BadRequestException(`${newManager.name} reports to this person, so cannot take over their team. Pick someone else.`);
  }
  await mapWithConcurrency(reports, 5, async (r) => {
    const wasPrimary = r.reportingManagerId === fromManagerId;
    const extras = (r.additionalReportingManagerIds ?? []).map((m) => (m === fromManagerId ? toManagerId : m));
    const primary = wasPrimary ? toManagerId : r.reportingManagerId;
    await scopedPrisma.user.updateMany({
      where: { id: r.id, organizationId },
      data: { reportingManagerId: primary, additionalReportingManagerIds: [...new Set(extras)].filter((m) => m !== primary) },
    });
    await timelineService.logEvent({
      organizationId,
      employeeId: r.id,
      eventKey: 'REPORTING_MANAGER_CHANGED',
      performedById: actorId,
      description: `Reporting manager reassigned to ${newManager.name}.`,
    });
  });
  await auditLogService.log({
    actorId,
    action: 'DIRECT_REPORTS_REASSIGNED',
    module: 'EMPLOYEE',
    organizationId,
    targetId: fromManagerId,
    details: { reassignedTo: toManagerId, employeeIds: reports.map((r) => r.id) },
  });
  return { count: reports.length, names: reports.map((r) => r.name) };
}

export async function reassignDirectReportsBeforeDeactivation(
  deps: ReassignDeps,
  employeeId: string,
  reassignManagerId: string | undefined,
  organizationId: string,
  actorId: string,
): Promise<void> {
  const directReports = await activeReportsOf(deps.scopedPrisma, employeeId, organizationId);
  if (directReports.length === 0) return;

  if (!reassignManagerId) {
    // `error` (not just `message`) is set explicitly so the global exception filter's `b.error ?? exception.name` passes
    // this exact string through as-is - the frontend checks for it to open the "pick a replacement manager" step
    // instead of showing a dead-end error toast. The list of reports is returned too, so the screen can name them.
    throw new BadRequestException({
      message: `This employee is the reporting manager for ${directReports.length} active employee(s) (${directReports
        .map((r) => r.name)
        .join(', ')}). Provide reassignManagerId (the replacement manager's id) to reassign them before deactivating.`,
      error: 'REASSIGN_MANAGER_REQUIRED',
      reports: directReports.map((r) => ({ id: r.id, name: r.name })),
    });
  }
  await reassignReports(deps, employeeId, reassignManagerId, organizationId, actorId);
}

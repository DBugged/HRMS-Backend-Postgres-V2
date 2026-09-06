// Purpose: Shared guard used wherever an employee gets deactivated — the plain PATCH .../deactivate route,
// the generic PATCH /employees/:id when it flips isActive to false, and offboarding's complete() — so a
// manager (or anyone else who happens to be another active employee's reportingManagerId) can never be
// deactivated leaving direct reports pointing at a manager who can no longer even log in.
// Responsibilities: Finds active direct reports of the employee being deactivated; if none, no-ops. If any
// exist, requires an explicit `reassignManagerId` (a validated, active, different employee) and reassigns
// every direct report to it in one bulk update, logging a REPORTING_MANAGER_CHANGED timeline event per
// affected employee plus one audit-log entry for the whole batch.
import { BadRequestException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import type { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import type { AuditLogService } from '../audit-log/audit-log.service';

export async function reassignDirectReportsBeforeDeactivation(
  deps: {
    scopedPrisma: ExtendedPrismaClient;
    timelineService: EmployeeTimelineService;
    auditLogService: AuditLogService;
  },
  employeeId: string,
  reassignManagerId: string | undefined,
  organizationId: string,
  actorId: string,
): Promise<void> {
  const { scopedPrisma, timelineService, auditLogService } = deps;

  const directReports = await scopedPrisma.user.findMany({
    where: { organizationId, reportingManagerId: employeeId, isActive: true },
    select: { id: true, name: true },
  });
  if (directReports.length === 0) return;

  if (!reassignManagerId) {
    // `error` (not just `message`) is set explicitly so the global
    // exception filter's `b.error ?? exception.name` passes this exact
    // string through as-is (it otherwise defaults to the generic
    // "Bad Request") — the frontend checks for it to switch straight to a
    // "pick a replacement manager" prompt instead of a dead-end error
    // toast. The direct-report list itself isn't threaded through here;
    // the frontend already has the full employee roster loaded and can
    // filter it client-side by reportingManagerId.
    throw new BadRequestException({
      message: `This employee is the reporting manager for ${directReports.length} active employee(s) (${directReports
        .map((r) => r.name)
        .join(
          ', ',
        )}). Provide reassignManagerId (the replacement manager's id) to reassign them before deactivating.`,
      error: 'REASSIGN_MANAGER_REQUIRED',
    });
  }
  if (reassignManagerId === employeeId) {
    throw new BadRequestException(
      'Cannot reassign direct reports to the employee being deactivated — pick someone else.',
    );
  }
  const newManager = await scopedPrisma.user.findFirst({
    where: { id: reassignManagerId, organizationId, isActive: true },
  });
  if (!newManager) {
    throw new BadRequestException(
      'The selected replacement manager was not found, or is inactive.',
    );
  }

  await scopedPrisma.user.updateMany({
    where: {
      id: { in: directReports.map((r) => r.id) },
      organizationId,
    },
    data: { reportingManagerId: reassignManagerId },
  });

  for (const report of directReports) {
    await timelineService.logEvent({
      organizationId,
      employeeId: report.id,
      eventKey: 'REPORTING_MANAGER_CHANGED',
      performedById: actorId,
      description: `Reporting manager reassigned to ${newManager.name}.`,
    });
  }
  await auditLogService.log({
    actorId,
    action: 'DIRECT_REPORTS_REASSIGNED',
    module: 'EMPLOYEE',
    organizationId,
    targetId: employeeId,
    details: {
      reassignedTo: reassignManagerId,
      employeeIds: directReports.map((r) => r.id),
    },
  });
}

// Purpose: CRUD for Department records, department-head assignment, and employee-to-department mapping.
// Responsibilities: Owns department lifecycle including deletion guard (blocks delete while employees are
// mapped); assignHead() folds a role promotion (to MANAGER) into the same call as head assignment.
// Important: assignHead() refuses to promote a user who already holds ADMIN/HR (NON_DEMOTABLE_ROLES) since
// that would silently demote their real role to MANAGER — mirrors the frontend's own NON_DEMOTABLE_ROLES list.
import { orgAttendanceDefaults } from './org-attendance-sync';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { MapEmployeesDto } from './dto/map-employees.dto';
import { BulkImportDepartmentsDto } from './dto/bulk-import-departments.dto';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';
import { computeWeeklyOffs } from '../work-schedules/work-schedules.service';
import {
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import type { AlternateWeeklyOffDto } from '../work-schedules/dto/create-work-schedule.dto';

// Mirrors the frontend's own NON_DEMOTABLE_ROLES — these roles already
// carry broader-than-department authority, so assigning one of these users
// as a department head must never overwrite their real role with MANAGER
// (that would silently demote them). Only a plain employee gets promoted.
const NON_DEMOTABLE_ROLES: Role[] = [Role.ADMIN, Role.HR];

const DEPARTMENT_INCLUDE = {
  departmentHead: {
    select: { id: true, name: true, employeeId: true, email: true },
  },
  workLocation: true,
  workSchedule: { select: { id: true, name: true } },
} satisfies Prisma.DepartmentInclude;

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    dto: CreateDepartmentDto,
    organizationId: string,
    actorId?: string,
  ) {
    const code = dto.code.toUpperCase();
    const existing = await this.scopedPrisma.department.findFirst({
      where: { organizationId, OR: [{ name: dto.name }, { code }] },
    });
    if (existing) {
      throw new ConflictException(
        'A department with this name or code already exists.',
      );
    }

    // A Work Schedule picked at creation time takes over shift/weekly-off/
    // break — same copy WorkSchedulesService.assign() does for an existing
    // department — and the raw shiftStartTime/shiftEndTime/weeklyOffs
    // fields above are ignored in favor of it.
    let scheduleFields:
      | Pick<
          Prisma.DepartmentUncheckedCreateInput,
          | 'workScheduleId'
          | 'shiftStartTime'
          | 'shiftEndTime'
          | 'weeklyOffs'
          | 'breakMinutes'
        >
      | undefined;
    if (dto.workScheduleId) {
      const schedule = await this.scopedPrisma.workSchedule.findFirst({
        where: { id: dto.workScheduleId, organizationId },
      });
      if (!schedule) {
        throw new BadRequestException('Work schedule not found.');
      }
      scheduleFields = {
        workScheduleId: schedule.id,
        shiftStartTime: schedule.startTime,
        shiftEndTime: schedule.endTime,
        weeklyOffs: computeWeeklyOffs(
          schedule.workingDays as number[],
          schedule.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
        ) as unknown as Prisma.InputJsonValue,
        breakMinutes: schedule.breakMinutes,
      };
    }

    // With no Work Schedule chosen, seed shift/threshold fields from the
    // org's own configured defaults (Organization.attendancePayrollPrefs)
    // instead of letting Prisma's column @default()s (09:30/18:30/15/15/
    // 8/4) silently apply — those are never actually "unset" once a row
    // exists (see resolveShiftConfig's comment), so a department created
    // this way would otherwise permanently diverge from whatever the org
    // configured in General Settings. dto fields, when explicitly passed,
    // still win over the org default.
    let orgDefaultFields:
      | Pick<
          Prisma.DepartmentUncheckedCreateInput,
          | 'shiftStartTime'
          | 'shiftEndTime'
          | 'lateInThresholdMinutes'
          | 'earlyOutThresholdMinutes'
          | 'minHoursForPresent'
          | 'minHoursForHalfDay'
          | 'weeklyOffs'
          | 'breakMinutes'
        >
      | undefined;
    if (!scheduleFields) {
      const org = await this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      });
      const orgDefaults = resolveShiftConfig(
        null,
        org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
      );
      orgDefaultFields = {
        shiftStartTime: dto.shiftStartTime || orgDefaults.shiftStartTime,
        shiftEndTime: dto.shiftEndTime || orgDefaults.shiftEndTime,
        lateInThresholdMinutes: orgDefaults.lateInThresholdMinutes,
        earlyOutThresholdMinutes: orgDefaults.earlyOutThresholdMinutes,
        minHoursForPresent: orgDefaults.minHoursForPresent,
        minHoursForHalfDay: orgDefaults.minHoursForHalfDay,
        weeklyOffs: (dto.weeklyOffs ??
          orgDefaults.weeklyOffs) as unknown as Prisma.InputJsonValue,
        breakMinutes: orgDefaults.breakMinutes,
      };
    }

    const department = await this.scopedPrisma.department.create({
      data: {
        organizationId,
        name: dto.name,
        code,
        description: dto.description ?? '',
        ...(scheduleFields ?? orgDefaultFields),
        ...(dto.crossesMidnight !== undefined && {
          crossesMidnight: dto.crossesMidnight,
        }),
      },
      include: DEPARTMENT_INCLUDE,
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_CREATED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: department.id,
        details: { name: department.name, code: department.code },
      });
    }

    return department;
  }

  // Client-parsed Excel/CSV import — same Promise.allSettled per-row
  // isolation as OrgListItemsService/DocumentRequirementsService's bulk
  // imports. Reuses create() itself for each row rather than duplicating
  // its duplicate-check/audit-log logic.
  async bulkImport(
    dto: BulkImportDepartmentsDto,
    organizationId: string,
    actorId?: string,
  ) {
    const results = await Promise.allSettled(
      dto.rows.map((row) => {
        const name = row.name?.trim();
        const code = row.code?.trim();
        if (!name || !code) {
          return Promise.reject(new Error('Row needs both a name and a code.'));
        }
        return this.create(
          { name, code, description: row.description?.trim() },
          organizationId,
          actorId,
        );
      }),
    );

    const created: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        created.push(result.value.name);
      } else {
        const reason =
          result.reason instanceof ConflictException
            ? 'A department with this name or code already exists.'
            : result.reason instanceof Error
              ? result.reason.message
              : 'Failed to import row.';
        skipped.push({ name: dto.rows[idx]?.name ?? '(unknown)', reason });
      }
    });

    return { created, skipped };
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.department.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      include: DEPARTMENT_INCLUDE,
    });
    return wrapAll(data);
  }

  // The org-level defaults a department starts from; the Manage Department form shows them and can reset to them.
  async attendanceDefaults(organizationId: string) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { attendancePayrollPrefs: true },
    });
    return orgAttendanceDefaults(
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );
  }

  private async findOrThrow(id: string, organizationId: string) {
    const department = await this.scopedPrisma.department.findFirst({
      where: { id, organizationId },
    });
    if (!department) throw new NotFoundException('Department not found.');
    return department;
  }

  async update(
    id: string,
    dto: UpdateDepartmentDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.findOrThrow(id, organizationId);
    const { workScheduleId, ...rest } = dto;

    // Deactivating (isActive: false) hides the department from every picker
    // and list, so it gets the same guard as remove(): no employees may
    // still be mapped to it.
    if (rest.isActive === false && existing.isActive) {
      const employeeCount = await this.scopedPrisma.user.count({
        where: { departmentId: id, organizationId },
      });
      if (employeeCount > 0) {
        throw new BadRequestException(
          'Cannot deactivate a department with employees mapped to it.',
        );
      }
    }

    // workScheduleId rides separately from the raw spread below because
    // assigning one (unlike every other field here) also copies that
    // schedule's hours/working-days/off-pattern/break minutes onto this
    // department — same propagation WorkSchedulesService.assign() does,
    // just triggered from the Department side instead of the Work
    // Schedules page. Unassigning (null) only clears the link; it
    // deliberately leaves whatever shift fields the department already
    // has alone rather than resetting them.
    let scheduleFields: Prisma.DepartmentUncheckedUpdateManyInput = {};
    if (workScheduleId !== undefined) {
      if (workScheduleId === null) {
        scheduleFields = { workScheduleId: null };
      } else {
        const schedule = await this.scopedPrisma.workSchedule.findFirst({
          where: { id: workScheduleId, organizationId },
        });
        if (!schedule) {
          throw new NotFoundException('Work schedule not found.');
        }
        scheduleFields = {
          workScheduleId,
          shiftStartTime: schedule.startTime,
          shiftEndTime: schedule.endTime,
          weeklyOffs: computeWeeklyOffs(
            schedule.workingDays as number[],
            schedule.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
          ),
          breakMinutes: schedule.breakMinutes,
        };
      }
    }

    await this.scopedPrisma.department.updateMany({
      where: { id, organizationId },
      data: { ...rest, ...scheduleFields },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_UPDATED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: id,
      });
    }

    return this.scopedPrisma.department.findFirstOrThrow({
      where: { id, organizationId },
      include: DEPARTMENT_INCLUDE,
    });
  }

  // Promotes a plain employee to MANAGER and stamps them as this
  // department's head in one step — mirrors the old system's
  // assignDepartmentHead, which folds the role change into the same call
  // rather than requiring a separate PATCH /employees/:id afterwards.
  async assignHead(id: string, userId: string, organizationId: string) {
    await this.findOrThrow(id, organizationId);
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: userId, organizationId },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (NON_DEMOTABLE_ROLES.includes(user.role)) {
      throw new BadRequestException(
        `${user.name} already has the ${user.role} role, which already covers every department — assign a regular employee as department head instead.`,
      );
    }

    await this.scopedPrisma.$transaction([
      this.scopedPrisma.department.updateMany({
        where: { id, organizationId },
        data: { departmentHeadId: userId },
      }),
      this.scopedPrisma.user.updateMany({
        where: { id: userId, organizationId },
        data: { role: Role.MANAGER, departmentId: id },
      }),
    ]);

    return this.scopedPrisma.department.findFirstOrThrow({
      where: { id, organizationId },
      include: DEPARTMENT_INCLUDE,
    });
  }

  async mapEmployees(id: string, dto: MapEmployeesDto, organizationId: string) {
    const department = await this.findOrThrow(id, organizationId);
    const { count } = await this.scopedPrisma.user.updateMany({
      where: { id: { in: dto.employeeIds }, organizationId },
      data: { departmentId: id },
    });
    return { message: `${count} employee(s) mapped to ${department.name}` };
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.findOrThrow(id, organizationId);
    const employeeCount = await this.scopedPrisma.user.count({
      where: { departmentId: id, organizationId },
    });
    if (employeeCount > 0) {
      throw new BadRequestException(
        'Cannot delete a department with employees mapped to it.',
      );
    }
    await this.scopedPrisma.department.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_DELETED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: id,
        details: { name: existing.name, code: existing.code },
      });
    }

    return { message: 'Department deleted.' };
  }
}

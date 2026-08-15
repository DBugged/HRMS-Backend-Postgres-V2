import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken } from '../files/file-token';
import { signPersonalDataFileUrls } from './personal-data';
import { UsersService } from '../users/users.service';
import { EmployeeIdService } from './employee-id.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { stripLockedFields } from './employee-field-lock';
import {
  Actor,
  canManagerAccessEmployee,
  resolveDepartmentFilter,
} from './employee-query-scope';

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
// Old system's ROLES_HR_CAN_ASSIGN — hr_admin may create employee/
// department_head/hr_admin accounts but never an administrator; only an
// ADMIN can create another ADMIN.
const ROLES_HR_CAN_ASSIGN: Role[] = [Role.EMPLOYEE, Role.MANAGER, Role.HR];

@Injectable()
export class EmployeesService {
  constructor(
    // The tenant-scope-extended client only — including for
    // $transaction(). Using the plain PrismaService's $transaction here
    // would give a transaction client WITHOUT the extension applied (the
    // extension wraps a specific client instance; $transaction called on
    // the unextended instance produces an unextended tx), which would
    // silently defeat the tenant-scope safety net for exactly the write
    // this service most needs it to cover.
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly usersService: UsersService,
    private readonly employeeIdService: EmployeeIdService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  async create(
    dto: CreateEmployeeDto,
    actor: Actor & { role: Role },
    organizationId: string,
  ) {
    const requestedRole = dto.role ?? Role.EMPLOYEE;
    if (
      actor.role === Role.HR &&
      !ROLES_HR_CAN_ASSIGN.includes(requestedRole)
    ) {
      throw new ForbiddenException(
        'Only an Admin can create an Admin account.',
      );
    }

    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const generatedPassword =
      crypto.randomBytes(6).toString('base64url') + 'A1!';
    const hashedPassword = await bcrypt.hash(generatedPassword, SALT_ROUNDS);

    const user = await this.scopedPrisma.$transaction(async (tx) => {
      const employeeId = await this.employeeIdService.generate(
        tx,
        organizationId,
      );
      return tx.user.create({
        data: {
          organizationId,
          employeeId,
          email: dto.email,
          password: hashedPassword,
          name: dto.name,
          role: requestedRole,
          departmentId: dto.departmentId,
          designation: dto.designation ?? '',
          contactNumber: dto.contactNumber ?? '',
          joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
          reportingManagerId: dto.reportingManagerId,
          employeeType: dto.employeeType ?? 'permanent',
          employmentStatus:
            dto.employeeType === 'probation' ? 'PROBATION' : 'ONBOARDING',
        },
      });
    });

    // Email delivery deferred (no Resend infra yet, same simplification as
    // Phase 1's registration flow) — the generated password is returned
    // once in the response instead, same as the old system's
    // createEmployeeManual for the no-email path.
    return { employee: toSafe(user), generatedPassword };
  }

  // Row-level isolation, same as the old system's bulkCreateEmployees —
  // one bad row (duplicate email, missing name) doesn't abort the rest of
  // the sheet. Reuses create() so seat limits, employeeId generation, and
  // role defaults all stay in exactly one place.
  async bulkCreate(
    rows: Array<
      Pick<
        CreateEmployeeDto,
        'name' | 'email' | 'designation' | 'contactNumber' | 'joiningDate'
      >
    >,
    actor: Actor & { role: Role },
    organizationId: string,
  ) {
    const created: string[] = [];
    const failed: { row: unknown; error: string }[] = [];

    for (const row of rows) {
      try {
        const { employee } = await this.create(row, actor, organizationId);
        created.push(employee.employeeId);
      } catch (err) {
        failed.push({
          row,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return { created, failed };
  }

  async findAll(
    query: ListEmployeesQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    const departmentId = resolveDepartmentFilter(actor, query.department);
    const where = {
      organizationId,
      ...(departmentId && { departmentId }),
      ...(query.role && { role: query.role }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' as const } },
          { email: { contains: query.search, mode: 'insensitive' as const } },
          {
            employeeId: {
              contains: query.search,
              mode: 'insensitive' as const,
            },
          },
        ],
      }),
    };

    const [rows, total] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { employeeId: 'asc' },
      }),
      this.scopedPrisma.user.count({ where }),
    ]);

    return {
      data: rows.map(toSafe),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async findOne(id: string, actor: Actor, organizationId: string) {
    const employee = await this.findByIdOrThrow(id, organizationId);
    if (!canManagerAccessEmployee(actor, employee.departmentId)) {
      throw new ForbiddenException(
        'You can only view employees in your own department.',
      );
    }
    return toSafe(employee);
  }

  async update(
    id: string,
    dto: UpdateEmployeeDto,
    actor: Actor & { id: string; role: Role },
    organizationId: string,
  ) {
    const before = await this.findByIdOrThrow(id, organizationId);
    const clean = stripLockedFields(dto, actor.role);

    // updateMany (not update) — its `where` accepts arbitrary filters, so
    // it can be organizationId-scoped directly, unlike update()'s unique-
    // only where (which the tenant-scope extension now forbids outright).
    // findByIdOrThrow above already confirmed the row exists in this org,
    // but re-scoping the write itself is what actually closes the gap,
    // not just the pre-check.
    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: {
        ...clean,
        joiningDate: clean.joiningDate
          ? new Date(clean.joiningDate)
          : undefined,
      },
    });

    await this.logChangesIfAny(before, clean, actor.id, organizationId);

    return toSafe(await this.findByIdOrThrow(id, organizationId));
  }

  // Append-only audit trail of role/designation/department/employmentStatus
  // transitions, written whenever update() actually changes one of them —
  // mirrors the old system's logAudit-adjacent behavior. Silent no-op for
  // any field the caller didn't touch.
  private async logChangesIfAny(
    before: User,
    clean: UpdateEmployeeDto,
    changedById: string,
    organizationId: string,
  ) {
    const roleChanged = clean.role !== undefined && clean.role !== before.role;
    const designationChanged =
      clean.designation !== undefined &&
      clean.designation !== before.designation;
    const departmentChanged =
      clean.departmentId !== undefined &&
      clean.departmentId !== before.departmentId;

    if (roleChanged || designationChanged || departmentChanged) {
      await this.scopedPrisma.employeeRoleHistory.create({
        data: {
          organizationId,
          employeeId: before.id,
          previousRole: roleChanged ? before.role : undefined,
          newRole: roleChanged ? clean.role : undefined,
          previousDesignation: designationChanged
            ? before.designation
            : undefined,
          newDesignation: designationChanged ? clean.designation : undefined,
          previousDepartmentId: departmentChanged
            ? before.departmentId
            : undefined,
          newDepartmentId: departmentChanged ? clean.departmentId : undefined,
          changedById,
        },
      });
      if (roleChanged) {
        await this.timelineService.logEvent({
          organizationId,
          employeeId: before.id,
          eventKey: 'ROLE_CHANGED',
          performedById: changedById,
        });
      }
      if (designationChanged) {
        await this.timelineService.logEvent({
          organizationId,
          employeeId: before.id,
          eventKey: 'DESIGNATION_CHANGED',
          performedById: changedById,
        });
      }
      if (departmentChanged) {
        await this.timelineService.logEvent({
          organizationId,
          employeeId: before.id,
          eventKey: 'DEPARTMENT_CHANGED',
          performedById: changedById,
        });
      }
    }

    if (
      clean.employmentStatus !== undefined &&
      clean.employmentStatus !== before.employmentStatus
    ) {
      await this.scopedPrisma.employmentStatusHistory.create({
        data: {
          organizationId,
          employeeId: before.id,
          previousStatus: before.employmentStatus,
          newStatus: clean.employmentStatus,
          changedById,
        },
      });
      // Generic fallback event for direct employmentStatus edits through
      // this endpoint. Flows with a dedicated meaning (probation
      // confirm/extend, offboarding) log their own specific eventKey
      // instead via their own services, so this only fires for the
      // plain PATCH /employees/:id path.
      await this.timelineService.logEvent({
        organizationId,
        employeeId: before.id,
        eventKey: 'EMPLOYEE_UPDATED',
        performedById: changedById,
      });
    }
  }

  async deactivate(id: string, organizationId: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { isActive: false },
    });
    return toSafe(await this.findByIdOrThrow(id, organizationId));
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<User> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    return employee;
  }
}

// profileImage is stored as a durable relativeKey (never a signed URL —
// see file-token.ts), so every response that surfaces one signs it fresh,
// same pattern as PolicyDocument's withSignedUrl / OrganizationSettings'
// withSignedUrls.
function toSafe(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
  const { password, ...safe } = user;
  if (safe.profileImage) {
    safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage)}`;
  }
  if (safe.personalData && typeof safe.personalData === 'object') {
    safe.personalData = signPersonalDataFileUrls(
      safe.personalData as Record<string, unknown>,
      safe.organizationId,
    ) as unknown as User['personalData'];
  }
  return safe;
}

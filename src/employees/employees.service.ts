// Purpose: Core employee CRUD — create/list/find/update/deactivate — plus credential issuance and change
// history tracking.
// Responsibilities: Owns password generation and welcome/resend-credentials email content; delegates
// employeeId generation to EmployeeIdService and change-history/timeline logging (logChangesIfAny) inline
// rather than to a shared audit helper; bulkCreate() reuses create() row-by-row so seat limits and role
// defaults stay in one place.
// Important: update() writes via updateMany (not update) so the write itself is organizationId-scoped, not
// just pre-checked by findByIdOrThrow — closing an actual tenant-isolation gap, not just a defensive
// pre-check. officialEmail is normalized to null (not '') on clear since it's a unique column and empty
// strings would collide across employees.
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { isEmail, isDateString } from 'class-validator';
import { Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken, SESSION_ASSET_TTL_SECONDS } from '../files/file-token';
import { signPersonalDataFileUrls } from './personal-data';
import { UsersService } from '../users/users.service';
import { EmployeeIdService } from './employee-id.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailService } from '../notifications/email.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { frontendUrl } from '../common/frontend-url';
import { mapWithConcurrency } from '../common/concurrency';
import { skip } from '../common/pagination';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { stripLockedFields } from './employee-field-lock';
import { mergePersonalData } from './personal-data';
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
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    dto: CreateEmployeeDto,
    actor: Actor & { id: string; role: Role },
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

    let user: User;
    try {
      user = await this.scopedPrisma.$transaction(async (tx) => {
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
            gradeLevel: dto.gradeLevel ?? '',
            employeeCategory: dto.employeeCategory ?? '',
            contactNumber: dto.contactNumber ?? '',
            joiningDate: dto.joiningDate
              ? new Date(dto.joiningDate)
              : undefined,
            reportingManagerId: dto.reportingManagerId,
            employeeType: dto.employeeType ?? 'permanent',
            employmentStatus:
              dto.employeeType === 'probation' ? 'PROBATION' : 'ONBOARDING',
            // personalEmail rides along at creation (rather than only via the
            // later personal-data PATCH) specifically so the welcome email
            // below always has somewhere to go on the interactive Add
            // Employee path. Absent for bulk-imported rows — see the DTO.
            personalData: dto.personalEmail
              ? (mergePersonalData(
                  {},
                  { personalEmail: dto.personalEmail },
                ) as Prisma.InputJsonValue)
              : undefined,
          },
        });
      });
    } catch (err) {
      // The findByEmail pre-check above is a TOCTOU race, not a guarantee —
      // two rows with the same email in the same bulkCreate() batch (or two
      // concurrent create() calls) can both pass it before either commits,
      // so the DB's unique constraint on email is the real backstop. Without
      // this catch, that race surfaced as a raw Prisma
      // PrismaClientKnownRequestError with a full stack trace and local
      // filesystem path leaking straight into the bulkCreate() per-row
      // error / the create() 500 response. Normalize it to the same
      // friendly, non-leaky message the pre-check already uses.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An account with this email already exists.',
        );
      }
      throw err;
    }

    // Welcome email — login URL, employee ID, generated password — sent to
    // the personal email HR just entered, since the official/company email
    // is normally still unset at this point (see officialEmail's comment on
    // the User model and resendCredentials() below for that path). Sent
    // after the transaction commits, and EmailService never throws (it
    // falls back to a console dry-run log on any delivery failure), so a
    // bad SMTP/Resend config can't roll back or fail employee creation —
    // the password is also still returned in the response either way, same
    // as the no-email fallback this replaces.
    if (dto.personalEmail) {
      await this.emailService.send({
        to: dto.personalEmail,
        subject: "Welcome to D'Bugged Programmers HRMS",
        html: welcomeEmailHtml({
          name: user.name,
          employeeId: user.employeeId,
          email: user.email,
          password: generatedPassword,
        }),
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_CREATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: user.id,
      details: { employeeId: user.employeeId, role: user.role },
    });

    // EMPLOYEE_RECORD_CREATED is the very first entry on a new employee's
    // 360° Employee Timeline — same pairing convention as every other
    // AuditLogService.log() call in this file (see the eventKey calls in
    // logChangesIfAny below), just previously missing for creation itself,
    // which left every new hire's timeline empty until their first
    // subsequent role/designation/department/status change.
    await this.timelineService.logEvent({
      organizationId,
      employeeId: user.id,
      eventKey: 'EMPLOYEE_RECORD_CREATED',
      performedById: actor.id,
    });

    return { employee: toSafe(user), generatedPassword };
  }

  // ADMIN/HR only (enforced in the controller) — used once an employee's
  // officialEmail has been set on their profile (it's normally unknown at
  // creation time) to also get them their login details there. The
  // original password can't literally be "resent" since it's hashed
  // immediately and never stored in plaintext, so this issues a fresh one
  // and invalidates the old one, same generation path as create().
  async resendCredentials(id: string, organizationId: string) {
    const employee = await this.findByIdOrThrow(id, organizationId);
    if (!employee.officialEmail) {
      throw new ConflictException(
        'This employee has no official email on file yet.',
      );
    }

    const generatedPassword =
      crypto.randomBytes(6).toString('base64url') + 'A1!';
    const hashedPassword = await bcrypt.hash(generatedPassword, SALT_ROUNDS);

    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { password: hashedPassword, mustChangePassword: true },
    });

    await this.emailService.send({
      to: employee.officialEmail,
      subject: "Your D'Bugged Programmers HRMS login credentials",
      html: welcomeEmailHtml({
        name: employee.name,
        employeeId: employee.employeeId,
        email: employee.email,
        password: generatedPassword,
      }),
    });

    return { success: true, sentTo: employee.officialEmail };
  }

  // Row-level isolation, same as the old system's bulkCreateEmployees —
  // one bad row (duplicate email, missing name) doesn't abort the rest of
  // the sheet. Reuses create() so seat limits, employeeId generation, and
  // role defaults all stay in exactly one place.
  //
  // Rows arrive untyped (BulkEmployeeRowDto only enforces they're present,
  // same pattern as ImportRowDto/BulkImportHolidaysDto) specifically so a
  // single malformed row — missing name, unparsable email — lands in
  // `failed` below instead of class-validator's ValidateNested rejecting
  // the *entire* batch with a 400 before any row-level logic ever runs,
  // which would defeat the fail-but-continue contract this method promises.
  async bulkCreate(
    rows: Array<{
      name?: unknown;
      email?: unknown;
      designation?: unknown;
      contactNumber?: unknown;
      joiningDate?: unknown;
    }>,
    actor: Actor & { id: string; role: Role },
    organizationId: string,
  ) {
    const created: string[] = [];
    const failed: { row: unknown; error: string }[] = [];

    // Bounded concurrency — create()'s employeeId allocation is already
    // safe under concurrent callers (a row-locked counter, see
    // EmployeeIdService.generate's SELECT ... FOR UPDATE), so several
    // rows in flight at once just overlaps each row's independent work
    // (bcrypt hashing, etc.) instead of a fully sequential loop.
    await mapWithConcurrency(rows, 5, async (row) => {
      const name = asString(row.name).trim();
      const email = asString(row.email).trim();
      const designation = asString(row.designation).trim();
      const contactNumber = asString(row.contactNumber).trim();
      const joiningDate = asString(row.joiningDate).trim();

      if (!name) {
        failed.push({ row, error: 'Name is required.' });
        return;
      }
      if (!email || !isEmail(email)) {
        failed.push({ row, error: 'A valid email is required.' });
        return;
      }
      if (joiningDate && !isDateString(joiningDate)) {
        failed.push({
          row,
          error: 'Joining date must be a valid date (YYYY-MM-DD).',
        });
        return;
      }

      try {
        const { employee } = await this.create(
          {
            name,
            email,
            designation: designation || undefined,
            contactNumber: contactNumber || undefined,
            joiningDate: joiningDate || undefined,
          },
          actor,
          organizationId,
        );
        created.push(employee.employeeId);
      } catch (err) {
        failed.push({
          row,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    });

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
        skip: skip(query.page, query.limit),
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

    // An HR/Admin/Manager record is editable only by an Admin (or by the
    // employee themselves, via self-service My Profile) — HR managing HR
    // or Admin's data was an unintended gap the plain SelfOrRoles(ADMIN,
    // HR) guard on this route didn't close, since it only checks the
    // caller's own role, never the target's.
    if (
      actor.id !== id &&
      actor.role !== Role.ADMIN &&
      (before.role === Role.ADMIN || before.role === Role.HR)
    ) {
      throw new ForbiddenException(
        'Only an Admin can edit an HR or Admin employee record.',
      );
    }

    const clean = stripLockedFields(dto, actor.role);

    // Same ROLES_HR_CAN_ASSIGN gate as create() — stripLockedFields() only
    // decides whether HR/Admin *may* touch `role` at all (vs. a plain
    // employee editing their own profile), it doesn't limit which role HR
    // can set it to. Without this check, HR could PATCH an employee's role
    // straight to ADMIN even though they're blocked from doing so at
    // creation time.
    if (
      actor.role === Role.HR &&
      clean.role !== undefined &&
      !ROLES_HR_CAN_ASSIGN.includes(clean.role)
    ) {
      throw new ForbiddenException('Only an Admin can assign an Admin role.');
    }

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
        // officialEmail is @unique — writing '' literally (rather than
        // null) means the second employee to clear it collides with the
        // first and gets an unhandled unique-constraint 500. '' and
        // "not yet provisioned" are the same thing to callers (see the
        // DTO's ValidateIf comment), so normalize to null on write; NULLs
        // are exempt from the unique index, unlike duplicate ''s.
        officialEmail: clean.officialEmail === '' ? null : clean.officialEmail,
        joiningDate: clean.joiningDate
          ? new Date(clean.joiningDate)
          : undefined,
      },
    });

    await this.logChangesIfAny(before, clean, actor.id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_UPDATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: id,
      details: {
        fields: Object.keys(clean).filter(
          (key) => clean[key as keyof UpdateEmployeeDto] !== undefined,
        ),
      },
    });

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

  async deactivate(
    id: string,
    actor: Actor & { id: string },
    organizationId: string,
  ) {
    await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { isActive: false },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_DEACTIVATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: id,
      details: { reason: 'manual_deactivation' },
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

// Bulk-import rows are untyped, client-parsed spreadsheet cells — this
// coerces only actual strings/numbers/booleans (the values a spreadsheet
// cell can realistically hold) rather than blindly calling String() on an
// arbitrary unknown, which could stringify to "[object Object]". Same
// helper as HolidaysService/AttendanceService use for the same reason.
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

// profileImage is stored as a durable relativeKey (never a signed URL —
// see file-token.ts), so every response that surfaces one signs it fresh,
// same pattern as PolicyDocument's withSignedUrl / OrganizationSettings'
// withSignedUrls.
function toSafe(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
  const { password, ...safe } = user;
  if (safe.profileImage) {
    // Held in AuthContext for the whole session, not re-fetched on every
    // navigation — see SESSION_ASSET_TTL_SECONDS' comment.
    safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage, SESSION_ASSET_TTL_SECONDS)}`;
  }
  if (safe.personalData && typeof safe.personalData === 'object') {
    safe.personalData = signPersonalDataFileUrls(
      safe.personalData as Record<string, unknown>,
      safe.organizationId,
    ) as unknown as User['personalData'];
  }
  return safe;
}

// Shared by both the initial welcome email (create()) and
// resendCredentials() — same content either way, just a different
// recipient address and (for a resend) a freshly-generated password.
function welcomeEmailHtml(params: {
  name: string;
  employeeId: string;
  email: string;
  password: string;
}): string {
  const loginUrl = `${frontendUrl()}/login`;
  return `
    <p>Hello ${params.name},</p>
    <p>Your account on D'Bugged Programmers HRMS is ready. Here are your login details:</p>
    <p>
      Login URL: <a href="${loginUrl}">${loginUrl}</a><br>
      Employee ID: <strong>${params.employeeId}</strong><br>
      Email: <strong>${params.email}</strong><br>
      Password: <strong>${params.password}</strong>
    </p>
    <p>You'll be asked to set a new password the first time you sign in. Please keep these details confidential.</p>
  `;
}

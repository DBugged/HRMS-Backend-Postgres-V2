// Purpose: Core employee CRUD — create/list/find/update/deactivate — plus credential issuance and change
// history tracking.
// Responsibilities: Owns password generation and welcome/resend-credentials email content; delegates
// employeeId generation to EmployeeIdService and change-history/timeline logging (logChangesIfAny) inline
// rather than to a shared audit helper; bulkCreate() reuses create() row-by-row so seat limits and role
// defaults stay in one place.
// Important: update() also writes EmployeeMovement history rows for department/designation/grade/manager changes
// (history only — the new values still apply immediately, never on a future effectiveDate). update() writes via updateMany (not update) so the write itself is organizationId-scoped, not
// just pre-checked by findByIdOrThrow — closing an actual tenant-isolation gap, not just a defensive
// pre-check. officialEmail is normalized to null (not '') on clear since it's a unique column and empty
// strings would collide across employees.
import { EMPLOYEE_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generatePolicyPassword } from '../common/password-policy';
import { isEmail, isDateString } from 'class-validator';
import {
  EmploymentStatus,
  OrgListType,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken, SESSION_ASSET_TTL_SECONDS } from '../files/file-token';
import { signPersonalDataFileUrls } from './personal-data';
import { UsersService } from '../users/users.service';
import { EmployeeIdService } from './employee-id.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { frontendUrl } from '../common/frontend-url';
import { escapeHtml } from '../email-templates/email-layout';
import { mapWithConcurrency } from '../common/concurrency';
import { skip } from '../common/pagination';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { DeactivateEmployeeDto } from './dto/deactivate-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { stripLockedFields } from './employee-field-lock';
import { mergePersonalData } from './personal-data';
import {
  Actor,
  canManagerAccessEmployee,
  noDepartmentManagerScope,
  resolveDepartmentFilter,
} from './employee-query-scope';
import { maskPersonalData } from './personal-data-mask';
import { PrivacyAuditService } from '../privacy/privacy-audit.service';
import { auditSensitive } from '../common/sensitive-audit';
import { reassignDirectReportsBeforeDeactivation } from '../common/manager-reassignment';
import { DEFAULT_EMPLOYEE_TYPES } from '../organizations/employee-types';

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
// Old system's ROLES_HR_CAN_ASSIGN — hr_admin may create employee/
// department_head/hr_admin accounts but never an administrator; only an
// ADMIN can create another ADMIN.
const ROLES_HR_CAN_ASSIGN: Role[] = [Role.EMPLOYEE, Role.MANAGER, Role.HR];

const MAX_MANAGER_CHAIN_HOPS = 100;

// Exit statuses: final, and they revoke login (same set offboarding applies).
export const EXIT_STATUSES: EmploymentStatus[] = [
  EmploymentStatus.RESIGNED,
  EmploymentStatus.RELEASED,
  EmploymentStatus.TERMINATED,
  EmploymentStatus.ABSCONDED,
];
const EXITS = EXIT_STATUSES;

// Allowed employmentStatus transitions via PATCH /employees/:id.
const EMPLOYMENT_STATUS_TRANSITIONS: Record<
  EmploymentStatus,
  EmploymentStatus[]
> = {
  ONBOARDING: [
    EmploymentStatus.PROBATION,
    EmploymentStatus.CONFIRMED,
    EmploymentStatus.ON_HOLD,
    ...EXITS,
  ],
  PROBATION: [
    EmploymentStatus.EXTENDED_PROBATION,
    EmploymentStatus.CONFIRMED,
    EmploymentStatus.NOTICE_PERIOD,
    EmploymentStatus.ON_HOLD,
    ...EXITS,
  ],
  EXTENDED_PROBATION: [
    EmploymentStatus.CONFIRMED,
    EmploymentStatus.NOTICE_PERIOD,
    EmploymentStatus.ON_HOLD,
    ...EXITS,
  ],
  CONFIRMED: [
    EmploymentStatus.NOTICE_PERIOD,
    EmploymentStatus.ON_HOLD,
    ...EXITS,
  ],
  // Back to an active status covers a withdrawn resignation.
  NOTICE_PERIOD: [
    EmploymentStatus.CONFIRMED,
    EmploymentStatus.PROBATION,
    EmploymentStatus.EXTENDED_PROBATION,
    ...EXITS,
  ],
  ON_HOLD: [
    EmploymentStatus.PROBATION,
    EmploymentStatus.EXTENDED_PROBATION,
    EmploymentStatus.CONFIRMED,
    EmploymentStatus.NOTICE_PERIOD,
    ...EXITS,
  ],
  RESIGNED: [],
  RELEASED: [],
  TERMINATED: [],
  ABSCONDED: [],
};

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
    private readonly emailTemplatesService: EmailTemplatesService,
    private readonly privacyAudit: PrivacyAuditService,
  ) {}

  async create(
    dto: CreateEmployeeDto,
    actor: Actor & { id: string; role: Role },
    organizationId: string,
    // Internal-only — bulkCreate() sets this to false when HR chose "No
    // email" for the whole batch, so every row still gets created and gets
    // a generated password normally, just without the fire-and-forget send
    // below. Never set by the controller directly: CreateEmployeeDto (the
    // manual "Add Employee" form) has no such flag — its own Email/No-email
    // choice is expressed by whether personalEmail is present at all.
    options?: { sendWelcomeEmail?: boolean },
  ) {
    const sendWelcomeEmail = options?.sendWelcomeEmail ?? true;
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

    await this.assertWorkLocationInOrg(dto.workLocationId, organizationId);

    const generatedPassword = generatePolicyPassword();
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
            workLocationId: dto.workLocationId ?? undefined,
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
            // No documents exist yet at creation time, so
            // mandatoryDocumentsUploaded is always false here — harmless,
            // since isProfileComplete(...) is false too at this point
            // regardless (only personalEmail is set).
            personalData: dto.personalEmail
              ? (mergePersonalData(
                  {},
                  { personalEmail: dto.personalEmail },
                  false,
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
      // departmentId / reportingManagerId can reference a row that doesn't
      // exist (wrong id, or one from another organization — scopedPrisma
      // doesn't validate FK targets, only WHERE clauses) — surface that as
      // a clean 400 instead of letting Postgres's FK-violation bubble up as
      // an unhandled 500 with a raw Prisma stack trace.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        throw new BadRequestException(
          'The specified department or reporting manager was not found.',
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
    if (dto.personalEmail && sendWelcomeEmail) {
      const org = await this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { companyName: true },
      });
      const companyName = org?.companyName || 'the company';
      // The email carries a one-time set-password link, never the password itself.
      const setPasswordUrl = await this.issueSetPasswordLink(
        user.id,
        organizationId,
      );
      const fallbackHtml = welcomeEmailHtml({
        companyName,
        name: user.name,
        employeeId: user.employeeId,
        email: user.email,
        setPasswordUrl,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'WELCOME_EMAIL',
        {
          employeeName: user.name,
          companyName,
          employeeId: user.employeeId,
          email: user.email,
          setPasswordUrl,
          loginUrl: `${frontendUrl()}/login`,
        },
        { subject: `Welcome to ${companyName} HRMS`, html: fallbackHtml },
      );
      // Fire-and-forget: EmailService.send() already never throws (falls
      // back to a console dry-run log on any delivery failure internally),
      // but it was previously awaited here anyway — so a slow/unresponsive
      // SMTP provider (a real-world Gmail SMTP handshake routinely takes
      // several seconds, more under load/throttling) held the whole
      // POST /employees response hostage. The frontend's Add Employee
      // dialog waits for that response before closing itself and
      // refreshing the employee list, so on a slow SMTP round-trip the
      // table would appear not to update until the admin gave up and
      // manually reloaded the page — even though the employee row had
      // already been committed to the database well before the email step
      // even started. Not awaiting here lets the request resolve as soon
      // as the DB write (and audit/timeline logging below) is done; the
      // email still goes out moments later in the background.
      void this.emailService
        .send({
          organizationId,
          to: dto.personalEmail,
          subject: rendered.subject,
          html: rendered.html,
        })
        .catch(() => {
          // EmailService.send() already handles/logs its own failures —
          // this is only a backstop against an unexpected synchronous
          // throw turning into an unhandled promise rejection.
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

  // One-time set-password link for welcome/resend emails: only the SHA-256 of the token is stored (same
  // hashing and /reset-password/:token flow as forgot-password, see AuthService.resetPassword) with a 7-day expiry.
  private async issueSetPasswordLink(
    userId: string,
    organizationId: string,
  ): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    await this.scopedPrisma.user.updateMany({
      where: { id: userId, organizationId },
      data: {
        resetPasswordToken: crypto
          .createHash('sha256')
          .update(rawToken)
          .digest('hex'),
        resetPasswordExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return `${frontendUrl()}/reset-password/${rawToken}`;
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

    const generatedPassword = generatePolicyPassword();
    const hashedPassword = await bcrypt.hash(generatedPassword, SALT_ROUNDS);

    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { password: hashedPassword, mustChangePassword: true },
    });

    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { companyName: true },
    });
    const companyName = org?.companyName || 'the company';
    const setPasswordUrl = await this.issueSetPasswordLink(id, organizationId);
    const fallbackHtml = welcomeEmailHtml({
      companyName,
      name: employee.name,
      employeeId: employee.employeeId,
      email: employee.email,
      setPasswordUrl,
    });
    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'LOGIN_CREDENTIALS_RESENT',
      {
        employeeName: employee.name,
        companyName,
        employeeId: employee.employeeId,
        email: employee.email,
        setPasswordUrl,
        loginUrl: `${frontendUrl()}/login`,
      },
      {
        subject: `Your ${companyName} HRMS login credentials`,
        html: fallbackHtml,
      },
    );
    await this.emailService.send({
      organizationId,
      to: employee.officialEmail,
      subject: rendered.subject,
      html: rendered.html,
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
      personalEmail?: unknown;
      department?: unknown;
      employeeCategory?: unknown;
      role?: unknown;
      employeeType?: unknown;
    }>,
    actor: Actor & { id: string; role: Role },
    organizationId: string,
    // Batch-level choice (default true) — see BulkCreateEmployeesDto.
    // Every row is still created and gets a generated password regardless;
    // this only controls whether create() also fires the welcome email.
    sendWelcomeEmail: boolean = true,
  ) {
    const created: {
      employeeId: string;
      name: string;
      email: string;
      generatedPassword: string;
    }[] = [];
    const failed: { row: unknown; error: string }[] = [];

    // Excel is a human-editable file, so department/employeeCategory/
    // employeeType are matched by NAME against the org's actual lists here
    // (not the internal ids/values the manual form's Selects submit) —
    // resolved once up front rather than per row, since every row in a
    // batch is checked against the same org-wide lists.
    const [departments, employeeCategoryItems, org] = await Promise.all([
      this.scopedPrisma.department.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      this.scopedPrisma.orgListItem.findMany({
        where: { organizationId, type: OrgListType.EMPLOYEE_CATEGORY },
        select: { name: true },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          customEmployeeTypes: true,
          inactiveBuiltinEmployeeTypes: true,
        },
      }),
    ]);
    const customEmployeeTypes =
      (org?.customEmployeeTypes as
        { value: string; label: string; isActive?: boolean }[] | null) ?? [];
    const inactiveBuiltins = org?.inactiveBuiltinEmployeeTypes ?? [];
    // Same "active" definition useEmployeeTypes()/EmployeeTypesService.findAll
    // use — built-ins minus any this org deactivated, plus active custom ones.
    const activeEmployeeTypes = [
      ...DEFAULT_EMPLOYEE_TYPES.filter(
        (t) => !inactiveBuiltins.includes(t.value),
      ),
      ...customEmployeeTypes.filter((t) => t.isActive ?? true),
    ];
    const validRoles = Object.values(Role);

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
      const personalEmail = asString(row.personalEmail).trim();
      const departmentName = asString(row.department).trim();
      const employeeCategoryName = asString(row.employeeCategory).trim();
      const roleInput = asString(row.role).trim();
      const employeeTypeInput = asString(row.employeeType).trim();

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
      // Mirrors the manual "Add Employee" form, which requires these same
      // five fields — personalEmail is also what makes the welcome email
      // actually go out for bulk-imported rows (it was previously never
      // collected, so bulk-imported employees never got one).
      if (!personalEmail || !isEmail(personalEmail)) {
        failed.push({ row, error: 'A valid personal email is required.' });
        return;
      }
      if (!departmentName) {
        failed.push({ row, error: 'Department is required.' });
        return;
      }
      const department = departments.find(
        (d) => d.name.toLowerCase() === departmentName.toLowerCase(),
      );
      if (!department) {
        failed.push({
          row,
          error: `Department "${departmentName}" not found.`,
        });
        return;
      }
      if (!employeeCategoryName) {
        failed.push({ row, error: 'Employee category is required.' });
        return;
      }
      const employeeCategory = employeeCategoryItems.find(
        (c) => c.name.toLowerCase() === employeeCategoryName.toLowerCase(),
      );
      if (!employeeCategory) {
        failed.push({
          row,
          error: `Employee category "${employeeCategoryName}" not found.`,
        });
        return;
      }
      if (!roleInput) {
        failed.push({ row, error: 'Role is required.' });
        return;
      }
      const role = validRoles.find(
        (r) => r.toLowerCase() === roleInput.toLowerCase(),
      );
      if (!role) {
        failed.push({
          row,
          error: `Role "${roleInput}" is not valid. Use one of: ${validRoles.join(', ')}.`,
        });
        return;
      }
      if (!employeeTypeInput) {
        failed.push({ row, error: 'Employee type is required.' });
        return;
      }
      const employeeType = activeEmployeeTypes.find(
        (t) =>
          t.value.toLowerCase() === employeeTypeInput.toLowerCase() ||
          t.label.toLowerCase() === employeeTypeInput.toLowerCase(),
      );
      if (!employeeType) {
        failed.push({
          row,
          error: `Employee type "${employeeTypeInput}" not found.`,
        });
        return;
      }

      try {
        const { employee, generatedPassword } = await this.create(
          {
            name,
            email,
            personalEmail,
            departmentId: department.id,
            designation: designation || undefined,
            employeeCategory: employeeCategory.name,
            contactNumber: contactNumber || undefined,
            joiningDate: joiningDate || undefined,
            role,
            employeeType: employeeType.value,
          },
          actor,
          organizationId,
          { sendWelcomeEmail },
        );
        created.push({
          employeeId: employee.employeeId,
          name: employee.name,
          email: employee.email,
          generatedPassword,
        });
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
    const noDeptScope = noDepartmentManagerScope(actor);
    const where = {
      organizationId,
      ...(departmentId && { departmentId }),
      ...(noDeptScope && { AND: [noDeptScope] }),
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
        include: { workLocation: WORK_LOCATION_SELECT },
        skip: skip(query.page, query.limit),
        take: query.limit,
        orderBy: query.sortBy
          ? [
              { [query.sortBy]: query.sortOrder ?? 'asc' },
              // Unique tiebreak keeps pagination stable on duplicate values.
              { id: 'asc' as const },
            ]
          : EMPLOYEE_ORDER_BY,
      }),
      this.scopedPrisma.user.count({ where }),
    ]);

    return {
      data: rows.map((r) => toSafe(r, maskFor(actor, r.id))),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async findOne(id: string, actor: Actor, organizationId: string) {
    const employee = await this.findByIdOrThrow(id, organizationId);
    const noDeptScope = noDepartmentManagerScope(actor);
    const ownOrDirectReport =
      !!noDeptScope &&
      !!actor.id &&
      (employee.id === actor.id || employee.reportingManagerId === actor.id);
    if (
      !ownOrDirectReport &&
      !canManagerAccessEmployee(actor, employee.departmentId)
    ) {
      throw new ForbiddenException(
        'You can only view employees in your own department.',
      );
    }
    // Personal data of another employee read by HR/ADMIN/MANAGER — record who looked at whom (never the values).
    if (actor.id && actor.id !== employee.id) {
      auditSensitive(
        this.privacyAudit,
        { id: actor.id, role: actor.role, organizationId },
        {
          action: 'PERSONAL_DATA_VIEWED',
          category: 'PERSONAL_DATA',
          targetUserId: employee.id,
          entity: 'User',
          entityId: employee.id,
        },
      );
    }
    return toSafe(employee, maskFor(actor, employee.id));
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

    // reassignManagerId is a transient instruction (see its DTO comment),
    // never a persisted column — pulled off before anything below spreads
    // the rest of the payload into the Prisma write.
    const {
      reassignManagerId,
      effectiveDate,
      changeReason,
      isPromotion,
      ...updateFields
    } = dto;
    const clean = stripLockedFields(updateFields, actor.role);
    await this.assertWorkLocationInOrg(clean.workLocationId, organizationId);

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

    // A deactivated employee's record is frozen except for reactivating
    // them — no promotion, department move, designation change, etc.
    // should slip through while the account is inactive; reactivate first,
    // then make the other change as its own separate call.
    if (!before.isActive) {
      const touchedFields = Object.keys(clean).filter(
        (key) => clean[key as keyof UpdateEmployeeDto] !== undefined,
      );
      const isReactivationOnly =
        touchedFields.length === 1 &&
        touchedFields[0] === 'isActive' &&
        clean.isActive === true;
      if (!isReactivationOnly) {
        throw new BadRequestException(
          'This employee is deactivated — reactivate them first before making any other changes.',
        );
      }
      // An exited employee (terminated/resigned/released/absconded) can't be
      // brought back by flipping isActive — that would resurrect a closed
      // record; rehire as a new employee instead.
      if (EXIT_STATUSES.includes(before.employmentStatus)) {
        throw new BadRequestException(
          `This employee has exited (${before.employmentStatus}) and cannot be reactivated.`,
        );
      }
    }

    // Employment-status lifecycle: only transitions in the allowed map are
    // accepted, and exit statuses are final.
    const statusChanging =
      clean.employmentStatus !== undefined &&
      clean.employmentStatus !== before.employmentStatus;
    if (statusChanging) {
      const allowed = EMPLOYMENT_STATUS_TRANSITIONS[before.employmentStatus];
      if (!allowed.includes(clean.employmentStatus as EmploymentStatus)) {
        throw new BadRequestException(
          allowed.length === 0
            ? `Employment status ${before.employmentStatus} is final and cannot be changed.`
            : `Invalid employment status transition: ${before.employmentStatus} → ${clean.employmentStatus}. Allowed: ${allowed.join(', ')}.`,
        );
      }
    }
    const exiting =
      statusChanging &&
      EXIT_STATUSES.includes(clean.employmentStatus as EmploymentStatus);
    if (exiting) {
      if (clean.isActive === true) {
        throw new BadRequestException(
          'An employee moved to an exit status cannot remain active.',
        );
      }
      // Exit statuses revoke login in the same write (sessions are revoked
      // after the write below).
      clean.isActive = false;
    }

    // Reporting manager: no self-reporting and no cycles in the chain.
    if (clean.reportingManagerId) {
      await this.assertNoReportingCycle(
        id,
        clean.reportingManagerId,
        organizationId,
      );
    }

    // Deactivating (not reactivating) someone who's still another active
    // employee's reportingManagerId requires reassigning those direct
    // reports first — otherwise they're left pointing at a manager who can
    // no longer even log in.
    if (clean.isActive === false && before.isActive) {
      await reassignDirectReportsBeforeDeactivation(
        {
          scopedPrisma: this.scopedPrisma,
          timelineService: this.timelineService,
          auditLogService: this.auditLogService,
        },
        id,
        reassignManagerId,
        organizationId,
        actor.id,
      );
    }

    // updateMany (not update) — its `where` accepts arbitrary filters, so
    // it can be organizationId-scoped directly, unlike update()'s unique-
    // only where (which the tenant-scope extension now forbids outright).
    // findByIdOrThrow above already confirmed the row exists in this org,
    // but re-scoping the write itself is what actually closes the gap,
    // not just the pre-check.
    try {
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
          officialEmail:
            clean.officialEmail === '' ? null : clean.officialEmail,
          joiningDate: clean.joiningDate
            ? new Date(clean.joiningDate)
            : undefined,
        },
      });
    } catch (err) {
      // Same FK-target-doesn't-exist case as create() — a bogus
      // departmentId/reportingManagerId (or one from another org) should
      // be a clean 400, not a raw Prisma P2003 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        throw new BadRequestException(
          'The specified department or reporting manager was not found.',
        );
      }
      throw err;
    }

    // Losing login (exit status or plain deactivation) also kills every
    // live session — same revocation offboarding/password-reset use.
    if (clean.isActive === false && before.isActive) {
      await this.scopedPrisma.refreshToken.updateMany({
        where: { userId: id, organizationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.logChangesIfAny(before, clean, actor.id, organizationId);
    await this.recordMovements(
      before,
      clean,
      { effectiveDate, changeReason, isPromotion },
      actor.id,
      organizationId,
    );

    // Tell the affected person their access role changed (security-relevant, and rare). Skipped
    // for a self-edit and for a deactivated account; best-effort, never fails the update.
    if (
      clean.role !== undefined &&
      clean.role !== before.role &&
      before.isActive &&
      before.id !== actor.id
    ) {
      void this.sendRoleChangedEmail(before, clean.role, organizationId);
    }

    // isActive isn't covered by logChangesIfAny (that only watches role/
    // designation/department/employmentStatus) — without this, toggling
    // it via this generic endpoint (as opposed to the dedicated
    // .../deactivate route) left an audit-log line but no Employee
    // Timeline entry at all, for either direction of the transition.
    if (clean.isActive !== undefined && clean.isActive !== before.isActive) {
      await this.timelineService.logEvent({
        organizationId,
        employeeId: id,
        eventKey: clean.isActive
          ? 'EMPLOYEE_REACTIVATED'
          : 'EMPLOYEE_DEACTIVATED',
        performedById: actor.id,
      });
    }

    const changedFieldKeys = Object.keys(clean).filter(
      (key) => clean[key as keyof UpdateEmployeeDto] !== undefined,
    );
    // Records before/after for every field that actually changed, not
    // just which field names were touched — a sensitive-change audit line
    // (role, isActive, department, designation, employment status) is far
    // less useful without knowing what it changed from and to.
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of changedFieldKeys) {
      const beforeVal = (before as Record<string, unknown>)[key];
      const afterVal = clean[key as keyof UpdateEmployeeDto];
      if (beforeVal !== afterVal)
        changes[key] = { before: beforeVal, after: afterVal };
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_UPDATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: id,
      details: { fields: changedFieldKeys, changes },
    });

    return toSafe(await this.findByIdOrThrow(id, organizationId));
  }

  private async sendRoleChangedEmail(
    before: User,
    newRole: Role,
    organizationId: string,
  ): Promise<void> {
    try {
      const label = (r: Role) => r.charAt(0) + r.slice(1).toLowerCase();
      const variables = {
        employeeName: before.name,
        previousRole: label(before.role),
        newRole: label(newRole),
      };
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'ROLE_CHANGED',
        variables,
        this.emailTemplatesService.defaultFor('ROLE_CHANGED', variables),
      );
      await this.emailService.send({
        organizationId,
        to: before.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    } catch {
      // best-effort notice — the role change itself has already been saved
    }
  }

  // Append-only audit trail of role/designation/department/employmentStatus
  // transitions, written whenever update() actually changes one of them —
  // mirrors the old system's logAudit-adjacent behavior. Silent no-op for
  // any field the caller didn't touch.
  // Writes EmployeeMovement history rows (transfer / promotion / designation / manager change). The new values
  // were already applied to the user by update(); effectiveDate is recorded for history only — there is no
  // effective-dated future application. Also emits the PROMOTION / REPORTING_MANAGER_CHANGED timeline events.
  private async recordMovements(
    before: User,
    clean: UpdateEmployeeDto,
    meta: {
      effectiveDate?: string;
      changeReason?: string;
      isPromotion?: boolean;
    },
    changedById: string,
    organizationId: string,
  ) {
    const departmentChanged =
      clean.departmentId !== undefined &&
      clean.departmentId !== before.departmentId;
    const locationChanged =
      clean.workLocationId !== undefined &&
      clean.workLocationId !== before.workLocationId;
    const designationChanged =
      clean.designation !== undefined &&
      clean.designation !== before.designation;
    const gradeChanged =
      clean.gradeLevel !== undefined && clean.gradeLevel !== before.gradeLevel;
    const managerChanged =
      clean.reportingManagerId !== undefined &&
      clean.reportingManagerId !== before.reportingManagerId;
    if (
      !departmentChanged &&
      !locationChanged &&
      !designationChanged &&
      !gradeChanged &&
      !managerChanged
    )
      return;

    const base = {
      organizationId,
      employeeId: before.id,
      effectiveDate:
        meta.effectiveDate ?? new Date().toISOString().slice(0, 10),
      reason: meta.changeReason,
      changedById,
    };
    const rows: Prisma.EmployeeMovementUncheckedCreateInput[] = [];
    if (departmentChanged || locationChanged) {
      rows.push({
        ...base,
        type: 'TRANSFER',
        ...(departmentChanged && {
          previousDepartmentId: before.departmentId,
          newDepartmentId: clean.departmentId,
        }),
        ...(locationChanged && {
          previousWorkLocationId: before.workLocationId,
          newWorkLocationId: clean.workLocationId,
        }),
      });
    }
    if (designationChanged || gradeChanged) {
      rows.push({
        ...base,
        type: meta.isPromotion ? 'PROMOTION' : 'DESIGNATION_CHANGE',
        previousDesignation: designationChanged
          ? before.designation
          : undefined,
        newDesignation: designationChanged ? clean.designation : undefined,
        previousGradeLevel: gradeChanged ? before.gradeLevel : undefined,
        newGradeLevel: gradeChanged ? clean.gradeLevel : undefined,
      });
    }
    if (managerChanged) {
      rows.push({
        ...base,
        type: 'MANAGER_CHANGE',
        previousReportingManagerId: before.reportingManagerId,
        newReportingManagerId: clean.reportingManagerId,
      });
    }
    await this.scopedPrisma.employeeMovement.createMany({ data: rows });

    if ((designationChanged || gradeChanged) && meta.isPromotion) {
      await this.timelineService.logEvent({
        organizationId,
        employeeId: before.id,
        eventKey: 'PROMOTION',
        performedById: changedById,
        remarks: meta.changeReason,
      });
    }
    if (locationChanged) {
      await this.timelineService.logEvent({
        organizationId,
        employeeId: before.id,
        eventKey: 'WORK_LOCATION_CHANGED',
        performedById: changedById,
        remarks: meta.changeReason,
      });
    }
    if (managerChanged) {
      await this.timelineService.logEvent({
        organizationId,
        employeeId: before.id,
        eventKey: 'REPORTING_MANAGER_CHANGED',
        performedById: changedById,
        remarks: meta.changeReason,
      });
    }
  }

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
    dto: DeactivateEmployeeDto,
    actor: Actor & { id: string },
    organizationId: string,
  ) {
    await this.findByIdOrThrow(id, organizationId);
    await reassignDirectReportsBeforeDeactivation(
      {
        scopedPrisma: this.scopedPrisma,
        timelineService: this.timelineService,
        auditLogService: this.auditLogService,
      },
      id,
      dto.reassignManagerId,
      organizationId,
      actor.id,
    );
    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { isActive: false },
    });
    await this.scopedPrisma.refreshToken.updateMany({
      where: { userId: id, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_DEACTIVATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: id,
      details: { reason: 'manual_deactivation' },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: id,
      eventKey: 'EMPLOYEE_DEACTIVATED',
      performedById: actor.id,
    });
    return toSafe(await this.findByIdOrThrow(id, organizationId));
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<User> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id, organizationId },
      include: { workLocation: WORK_LOCATION_SELECT },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    return employee;
  }

  // Rejects a reporting manager that is the employee themself, or whose own
  // manager chain already leads back to the employee (which would close a
  // cycle). Bounded walk so pre-existing corrupt chains can't loop forever.
  private async assertNoReportingCycle(
    employeeId: string,
    managerId: string,
    organizationId: string,
  ) {
    if (managerId === employeeId) {
      throw new BadRequestException(
        'An employee cannot be their own reporting manager.',
      );
    }
    const seen = new Set<string>();
    let current: string | null = managerId;
    for (let hops = 0; current && hops < MAX_MANAGER_CHAIN_HOPS; hops++) {
      if (current === employeeId) {
        throw new BadRequestException(
          'This reporting manager would create a circular reporting chain.',
        );
      }
      if (seen.has(current)) break; // existing cycle not involving this employee
      seen.add(current);
      const row: { reportingManagerId: string | null } | null =
        await this.scopedPrisma.user.findFirst({
          where: { id: current, organizationId },
          select: { reportingManagerId: true },
        });
      current = row?.reportingManagerId ?? null;
    }
  }

  // workLocationId (nullable override) must reference a location of the same organization.
  private async assertWorkLocationInOrg(
    workLocationId: string | null | undefined,
    organizationId: string,
  ) {
    if (!workLocationId) return;
    const loc = await this.scopedPrisma.workLocation.findFirst({
      where: { id: workLocationId, organizationId },
      select: { id: true },
    });
    if (!loc) {
      throw new BadRequestException(
        'The specified work location was not found.',
      );
    }
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
// Effective work location = user.workLocationId ?? department.workLocationId (see common/effective-work-location.ts).
const WORK_LOCATION_SELECT = {
  select: { id: true, name: true, state: true },
} as const;

// A MANAGER sees other employees' sensitive identifiers (PAN/Aadhaar/UAN/bank/passport) masked to the last 4
// characters; HR/ADMIN and the employee themself see everything.
function maskFor(actor: Actor, targetId: string): boolean {
  return actor.role === Role.MANAGER && actor.id !== targetId;
}

function toSafe(user: User, mask = false) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash + reset-token fields deliberately
  const { password, resetPasswordToken, resetPasswordExpires, ...safe } = user;
  if (safe.profileImage) {
    // Held in AuthContext for the whole session, not re-fetched on every
    // navigation — see SESSION_ASSET_TTL_SECONDS' comment.
    safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage, SESSION_ASSET_TTL_SECONDS)}`;
  }
  if (safe.personalData && typeof safe.personalData === 'object') {
    safe.personalData = signPersonalDataFileUrls(
      mask
        ? maskPersonalData(safe.personalData as Record<string, unknown>)
        : (safe.personalData as Record<string, unknown>),
      safe.organizationId,
    ) as unknown as User['personalData'];
  }
  return safe;
}

// Shared by both the initial welcome email (create()) and
// resendCredentials() — same content either way, just a different
// recipient address and (for a resend) a freshly-generated password.
function welcomeEmailHtml(params: {
  companyName: string;
  name: string;
  employeeId: string;
  email: string;
  setPasswordUrl: string;
}): string {
  const loginUrl = `${frontendUrl()}/login`;
  const name = escapeHtml(params.name);
  const company = escapeHtml(params.companyName);
  return `
    <p>Hello ${name},</p>
    <p>Your account on ${company} HRMS is ready. Here are your login details:</p>
    <p>
      Login URL: <a href="${loginUrl}">${loginUrl}</a><br>
      Employee ID: <strong>${escapeHtml(params.employeeId)}</strong><br>
      Email: <strong>${escapeHtml(params.email)}</strong>
    </p>
    <p><a href="${params.setPasswordUrl}">Set your password</a> (this link works once and expires in 7 days).</p>
  `;
}

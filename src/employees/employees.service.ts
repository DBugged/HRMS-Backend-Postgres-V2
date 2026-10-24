// Purpose: Core employee CRUD — create/list/find/update/deactivate — plus credential issuance and change
// history tracking.
// Responsibilities: Owns password generation and welcome/resend-credentials email content; delegates
// employeeId generation to EmployeeIdService and change-history/timeline logging (logChangesIfAny) inline
// rather than to a shared audit helper; bulkCreate() reuses create() row-by-row so seat limits and role
// defaults stay in one place.
// Important: update() also writes EmployeeMovement history rows for department/designation/grade/manager changes
// (history only — the new values still apply immediately, never on a future effectiveDate). update() writes via updateMany (not update) so the write itself is organizationId-scoped, not
// just pre-checked by findByIdOrThrow — closing an actual tenant-isolation gap, not just a defensive
// pre-check.
import { isManagerOf } from '../common/managers';
import { assertEmployeeRoom } from '../module-access/module-gate';
import { buildOrgChart } from './org-chart';
import {
  compareProbation,
  probationBucket,
  probationDaysLeft,
} from './probation-tracker';
import { EMPLOYEE_ORDER_BY } from '../common/employee-order';
import { AttendanceService } from '../attendance/attendance.service';
import { PayrollService } from '../payroll/payroll.service';
import { todayInOrgTz } from '../common/org-date';
import { enumerateDateStrings } from '../attendance/attendance-shift-config';
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
  Gender,
  OrgListType,
  Prisma,
  AttendanceStatus,
  PayrollRunStatus,
  Role,
  SelfieRequirement,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { toSafe } from './to-safe';
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
import { lockedFieldAttempts, stripLockedFields } from './employee-field-lock';
import { mergePersonalData } from './personal-data';
import {
  Actor,
  canManagerAccessEmployee,
  collectReportingChain,
  noDepartmentManagerScope,
  resolveDepartmentFilter,
} from './employee-query-scope';
import { PrivacyAuditService } from '../privacy/privacy-audit.service';
import { auditSensitive } from '../common/sensitive-audit';
import { reassignReports, reassignDirectReportsBeforeDeactivation } from '../common/manager-reassignment';
import { assertAccountCanLeave } from '../common/account-guard';
import { DEFAULT_EMPLOYEE_TYPES } from '../organizations/employee-types';
import { normalizeEmail } from '../common/normalize-input';

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
// The original release's ROLES_HR_CAN_ASSIGN — hr_admin may create employee/
// department_head/hr_admin accounts but never an administrator; only an
// ADMIN can create another ADMIN.
const ROLES_HR_CAN_ASSIGN: Role[] = [Role.EMPLOYEE, Role.MANAGER, Role.HR];

const MAX_MANAGER_CHAIN_HOPS = 100;

const addDaysStr = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// bulkCreate()'s Excel rows carry Gender as a human-typed label (or the
// raw enum value), same reasoning as role/employeeType's name-matching
// below — this resolves either form case-insensitively.
// Bulk import's optional "Selfie at Punch" column (blank = follow the org
// setting). Accepts the label or the raw enum value.
const SELFIE_LABELS = new Map<string, SelfieRequirement>([
  ['company setting', SelfieRequirement.DEFAULT],
  ['use company setting', SelfieRequirement.DEFAULT],
  ['default', SelfieRequirement.DEFAULT],
  ['required', SelfieRequirement.REQUIRED],
  ['always required', SelfieRequirement.REQUIRED],
  ['not required', SelfieRequirement.NOT_REQUIRED],
  ['not_required', SelfieRequirement.NOT_REQUIRED],
]);

const GENDER_LABELS = new Map<string, Gender>([
  ['male', Gender.MALE],
  ['female', Gender.FEMALE],
  ['other', Gender.OTHER],
  ['prefer not to say', Gender.PREFER_NOT_TO_SAY],
  ['prefer_not_to_say', Gender.PREFER_NOT_TO_SAY],
]);

// Final exit statuses: the person has left, the account is closed, and the status can no longer change.
export const EXIT_STATUSES: EmploymentStatus[] = [
  EmploymentStatus.RELEASED,
  EmploymentStatus.TERMINATED,
  EmploymentStatus.ABSCONDED,
];
// Statuses that are only reached through Resignation / Offboarding, never by editing the field: RESIGNED (serving
// notice - it needs a last working day and a checklist behind it) and the final exits.
export const LEAVING_STATUSES: EmploymentStatus[] = [
  EmploymentStatus.RESIGNED,
  ...EXIT_STATUSES,
];

// Accounts close only through Offboarding (final settlement and clearance first), so every exit is a recorded
// offboarding case: headcount, leavers and attrition stay correct and no final pay is left stranded.
const DEACTIVATION_BLOCKED_MESSAGE =
  'An employee is not deactivated directly. Start their Resignation or Offboarding - the account is closed when the offboarding is completed.';

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
    private readonly attendanceService: AttendanceService,
    private readonly payrollService: PayrollService,
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
    // The Super Admin may cap this company's employee count; bulk import goes through here row by row.
    await assertEmployeeRoom(organizationId);

    await this.assertWorkLocationInOrg(dto.workLocationId, organizationId);
    await this.assertOrgReferences(dto, organizationId);
    // Extra managers beyond the primary (an Admin reports to nobody, so none).
    const extraManagers =
      (dto.role ?? Role.EMPLOYEE) === Role.ADMIN
        ? []
        : await this.cleanExtraManagers(dto.additionalReportingManagerIds, dto.reportingManagerId, undefined, organizationId);
    await this.assertContactNumberUnique(dto.contactNumber, organizationId);

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
            requireWorkLocationForPunch:
              dto.requireWorkLocationForPunch ?? undefined,
            selfieRequirement: dto.selfieRequirement ?? undefined,
            locationRequirement: dto.locationRequirement ?? undefined,
            designation: dto.designation ?? '',
            gradeLevel: dto.gradeLevel ?? '',
            employeeCategory: dto.employeeCategory ?? '',
            contactNumber: dto.contactNumber ?? '',
            gender: dto.gender,
            joiningDate: dto.joiningDate
              ? new Date(dto.joiningDate)
              : undefined,
            // An Admin reports to nobody: their requests are decided by an Admin, never routed to HR.
            reportingManagerId:
              requestedRole === Role.ADMIN ? undefined : dto.reportingManagerId,
            additionalReportingManagerIds: extraManagers,
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

    // Welcome email — login URL, login email, employee ID (reference only), set-password link — sent to
    // the personal email HR just entered, since the login mailbox may not
    // exist yet (see resendCredentials() below for that path). Sent
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

  // ADMIN/HR only (enforced in the controller) — sends to personalEmail,
  // the same address the original welcome email went to (see create()),
  // not the login email: personalEmail is the one address that's guaranteed
  // to exist and stays reachable even after the employee has resigned. The
  // original password can't literally be "resent" since it's hashed
  // immediately and never stored in plaintext, so this issues a fresh one
  // and invalidates the old one, same generation path as create().
  async resendCredentials(id: string, organizationId: string) {
    const employee = await this.findByIdOrThrow(id, organizationId);
    const personalEmail = (
      employee.personalData as Record<string, unknown> | null
    )?.personalEmail;
    if (typeof personalEmail !== 'string' || !personalEmail) {
      throw new ConflictException(
        'This employee has no personal email on file yet.',
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
    const sent = await this.emailService.send({
      organizationId,
      to: personalEmail,
      subject: rendered.subject,
      html: rendered.html,
    });

    // The new password and set-password link exist either way; emailSent says whether the mail actually left, so the
    // caller no longer reports "sent" for a message the mail provider refused.
    return { success: true, emailSent: !sent.dryRun, sentTo: personalEmail };
  }

  // Row-level isolation, same as the original release's bulkCreateEmployees —
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
      gender?: unknown;
      joiningDate?: unknown;
      selfieAtPunch?: unknown;
      personalEmail?: unknown;
      department?: unknown;
      employeeCategory?: unknown;
      workLocation?: unknown;
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
    const [departments, workLocationItems, employeeCategoryItems, org] =
      await Promise.all([
        this.scopedPrisma.department.findMany({
          where: { organizationId },
          select: { id: true, name: true },
        }),
        this.scopedPrisma.workLocation.findMany({
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
      // Same normalization as the DTOs' @NormalizeEmail (trim + lowercase).
      const email = normalizeEmail(asString(row.email));
      const designation = asString(row.designation).trim();
      const contactNumber = asString(row.contactNumber).trim();
      const genderInput = asString(row.gender).trim();
      const joiningDate = asString(row.joiningDate).trim();
      const personalEmail = normalizeEmail(asString(row.personalEmail));
      const departmentName = asString(row.department).trim();
      const employeeCategoryName = asString(row.employeeCategory).trim();
      const workLocationName = asString(row.workLocation).trim();
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
          error: 'Joining date must be a valid date (DD-MM-YYYY).',
        });
        return;
      }
      // Matches the manual "Add Employee" form's own required Gender field
      // — feeds LeaveType.applicableGenders eligibility, which has no other
      // way to be set at creation time. Accepts either the raw enum value
      // (MALE/FEMALE/OTHER/PREFER_NOT_TO_SAY) or its display label.
      if (!genderInput) {
        failed.push({ row, error: 'Gender is required.' });
        return;
      }
      const gender = GENDER_LABELS.get(genderInput.toLowerCase());
      if (!gender) {
        failed.push({
          row,
          error: `Gender "${genderInput}" is not valid. Use one of: Male, Female, Other, Prefer not to say.`,
        });
        return;
      }
      const selfieInput = asString(row.selfieAtPunch).trim();
      const selfieRequirement = selfieInput
        ? SELFIE_LABELS.get(selfieInput.toLowerCase())
        : SelfieRequirement.DEFAULT;
      if (!selfieRequirement) {
        failed.push({
          row,
          error: `Selfie at Punch "${selfieInput}" is not valid. Use one of: Company setting, Required, Not required (or leave blank).`,
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
      if (!designation) {
        failed.push({ row, error: 'Designation is required.' });
        return;
      }
      if (!workLocationName) {
        failed.push({ row, error: 'Work location is required.' });
        return;
      }
      const workLocation = workLocationItems.find(
        (l) => l.name.toLowerCase() === workLocationName.toLowerCase(),
      );
      if (!workLocation) {
        failed.push({
          row,
          error: `Work location "${workLocationName}" not found.`,
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
            workLocationId: workLocation.id,
            designation,
            employeeCategory: employeeCategory.name,
            contactNumber: contactNumber || undefined,
            gender,
            joiningDate: joiningDate || undefined,
            selfieRequirement,
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

  // The directory list is open to every role, so someone who is not HR/Admin sees only the public directory fields of
  // a colleague - never their personal data (date of birth, address, family, CTC, bank/ID numbers, document links) or
  // phone number. A person's own row, and anything HR/Admin asks for, is complete.
  private forViewer<T extends Record<string, unknown>>(
    safe: T,
    rowId: string,
    actor: Actor,
  ): T {
    if (actor.role === Role.ADMIN || actor.role === Role.HR) return safe;
    if (rowId === actor.id) return safe;
    const { personalData, contactNumber: _contactNumber, ...rest } = safe;
    // Only the "profile complete" flag the directory column shows.
    const completed = !!(personalData as Record<string, unknown> | null)
      ?.profileCompleted;
    return {
      ...rest,
      personalData: { profileCompleted: completed },
      contactNumber: null,
    } as unknown as T;
  }

  // Everyone currently on probation (or an extended one), with days left to the end date and how urgent the decision
  // is, most urgent first - the Probation Tracker. ADMIN/HR see the whole organization; a MANAGER only their department.
  async probationTracker(actor: Actor, organizationId: string) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const departmentId = resolveDepartmentFilter(actor);
    const noDeptScope = noDepartmentManagerScope(actor);
    const rows = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        employmentStatus: { in: ['PROBATION', 'EXTENDED_PROBATION'] },
        // Not someone who is leaving: there is no probation decision left to take.
        exitDate: null,
        ...(departmentId && { departmentId }),
        ...(noDeptScope && { AND: [noDeptScope] }),
      },
      select: {
        id: true,
        employeeId: true,
        name: true,
        designation: true,
        joiningDate: true,
        probationEndDate: true,
        employmentStatus: true,
        department: { select: { name: true } },
        reportingManager: { select: { id: true, name: true } },
      },
    });
    return rows
      .map((r) => {
        const daysLeft = probationDaysLeft(today, r.probationEndDate);
        return {
          id: r.id,
          employeeId: r.employeeId,
          name: r.name,
          designation: r.designation,
          department: r.department?.name ?? '',
          joiningDate: r.joiningDate.toISOString().slice(0, 10),
          probationEndDate: r.probationEndDate,
          extended: r.employmentStatus === 'EXTENDED_PROBATION',
          reportingManager: r.reportingManager?.name ?? null,
          daysLeft,
          bucket: probationBucket(daysLeft),
        };
      })
      .sort(compareProbation);
  }

  // The company's reporting tree for the Org Chart: current employees only (no one who has left), with just the
  // fields a chart needs - name, designation, department and who they report to. Open to every role, like the
  // employee list behind Reporting Structure; nothing personal is included.
  async orgChart(organizationId: string) {
    const rows = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        employmentStatus: { notIn: EXIT_STATUSES },
      },
      select: {
        id: true,
        employeeId: true,
        name: true,
        designation: true,
        reportingManagerId: true,
        department: { select: { name: true } },
      },
    });
    return buildOrgChart(
      rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        name: r.name,
        designation: r.designation,
        department: r.department?.name ?? '',
        reportingManagerId: r.reportingManagerId,
      })),
    );
  }

  async findAll(
    query: ListEmployeesQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    // "My Team" (?myTeam=true): the caller's reporting chain (their direct reports and everyone below them). For a
    // MANAGER it replaces the department scope; for ADMIN/HR (otherwise unfiltered) it narrows the full list to
    // their own reports. Anyone else is unaffected.
    const teamIds =
      query.myTeam &&
      (actor.role === Role.MANAGER ||
        actor.role === Role.HR ||
        actor.role === Role.ADMIN) &&
      actor.id
        ? collectReportingChain(
            actor.id,
            await this.scopedPrisma.user.findMany({
              where: { organizationId },
              select: { id: true, reportingManagerId: true, additionalReportingManagerIds: true },
            }),
          )
        : null;
    const departmentId = teamIds
      ? undefined
      : resolveDepartmentFilter(actor, query.department);
    const noDeptScope = teamIds ? undefined : noDepartmentManagerScope(actor);
    const where = {
      organizationId,
      ...(teamIds && { id: { in: teamIds } }),
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
      data: rows.map((r) =>
        this.forViewer(toSafe(r, maskFor(actor, r.id)), r.id, actor),
      ),
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
      (employee.id === actor.id || isManagerOf(actor.id, employee));
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
    // Names for the extra reporting managers, so the profile can show them without a second lookup.
    const extraIds = employee.additionalReportingManagerIds ?? [];
    const additionalReportingManagers = extraIds.length
      ? await this.scopedPrisma.user.findMany({
          where: { id: { in: extraIds }, organizationId },
          select: { id: true, name: true, employeeId: true },
        })
      : [];
    return { ...toSafe(employee, maskFor(actor, employee.id)), additionalReportingManagers };
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
    // Department, designation, employee category and work location are required on every employee, so an edit
    // cannot blank one that is set (a blank sent for one that is already empty is a no-op).
    const requiredFields: [string, string][] = [
      ['departmentId', 'Department'],
      ['designation', 'Designation'],
      ['employeeCategory', 'Employee category'],
      ['workLocationId', 'Work location'],
    ];
    const cleared = requiredFields.filter(([key]) => {
      const sent = (updateFields as Record<string, unknown>)[key];
      const existing = (before as unknown as Record<string, unknown>)[key];
      return (
        (sent === null || (typeof sent === 'string' && !sent.trim())) &&
        !!existing
      );
    });
    if (cleared.length > 0) {
      throw new BadRequestException(
        `${cleared.map(([, label]) => label).join(', ')} cannot be cleared.`,
      );
    }
    const blocked = lockedFieldAttempts(
      updateFields,
      before as unknown as Record<string, unknown>,
      actor.role,
    );
    if (blocked.length > 0) {
      throw new ForbiddenException(
        actor.role === Role.HR && blocked.every((f) => f === 'designation')
          ? 'Only an Admin can change Designation.'
          : `You are not allowed to change: ${blocked.join(', ')}. Ask HR or an Admin to update it.`,
      );
    }
    const clean = stripLockedFields(updateFields, actor.role);
    await this.assertWorkLocationInOrg(clean.workLocationId, organizationId);
    await this.assertOrgReferences(
      clean,
      organizationId,
      before.reportingManagerId,
    );
    await this.assertContactNumberUnique(
      clean.contactNumber,
      organizationId,
      id,
    );

    // Same ROLES_HR_CAN_ASSIGN gate as create() — stripLockedFields() only
    // decides whether HR/Admin *may* touch `role` at all (vs. a plain
    // employee editing their own profile), it doesn't limit which role HR
    // can set it to. Without this check, HR could PATCH an employee's role
    // straight to ADMIN even though they're blocked from doing so at
    // creation time.
    if (clean.role !== undefined && clean.role !== Role.ADMIN && before.role === Role.ADMIN) {
      await assertAccountCanLeave(this.scopedPrisma, id, organizationId);
    }
    if (
      actor.role === Role.HR &&
      clean.role !== undefined &&
      !ROLES_HR_CAN_ASSIGN.includes(clean.role)
    ) {
      throw new ForbiddenException('Only an Admin can assign an Admin role.');
    }

    // Only ADMIN/HR ever reach `clean.isActive` at all — stripLockedFields
    // strips it for a plain employee editing their own profile — but
    // neither role check stops an Admin (or HR) from deactivating their
    // *own* record, which immediately revokes every one of their own
    // sessions below and locks them out with no one left to reactivate
    // them. Reactivating is still fine on your own record (e.g. an
    // in-progress self-edit that never actually went inactive).
    if (actor.id === id && clean.isActive === false) {
      throw new BadRequestException(
        'You cannot deactivate your own account — ask another Admin or HR to do it.',
      );
    }
    if (clean.isActive === false && before.isActive) {
      throw new BadRequestException(DEACTIVATION_BLOCKED_MESSAGE);
    }

    // The organization must always keep an active Admin: nobody can demote or deactivate the last one (this used to
    // be possible through PATCH even though the deactivate route refused it, leaving a company nobody could administer).
    if (
      before.role === Role.ADMIN &&
      ((clean.role !== undefined && clean.role !== Role.ADMIN) ||
        clean.isActive === false)
    ) {
      await this.assertAnotherActiveAdminRemains(id, organizationId);
    }

    // A person who has left (Released / Terminated / Absconded) can be brought back by Admin / HR changing their
    // status to a working one: that reinstates them - the account is reopened in the same save. Their status can also
    // be corrected between the exit statuses. Nothing else on a closed record changes (and flipping only isActive on
    // an exited person is refused: say which status they return to).
    const exitedBefore = EXIT_STATUSES.includes(before.employmentStatus);
    const targetStatus = clean.employmentStatus as EmploymentStatus | undefined;
    const reinstating =
      exitedBefore &&
      targetStatus !== undefined &&
      targetStatus !== before.employmentStatus &&
      !LEAVING_STATUSES.includes(targetStatus);
    const correctingExit =
      exitedBefore &&
      targetStatus !== undefined &&
      targetStatus !== before.employmentStatus &&
      EXIT_STATUSES.includes(targetStatus);
    if (!before.isActive) {
      const touchedFields = Object.keys(clean).filter(
        (key) => clean[key as keyof UpdateEmployeeDto] !== undefined,
      );
      const statusOnly =
        touchedFields.length > 0 &&
        touchedFields.every(
          (k) => k === 'employmentStatus' || k === 'isActive',
        );
      const isReactivationOnly =
        touchedFields.length === 1 &&
        touchedFields[0] === 'isActive' &&
        clean.isActive === true;
      if (exitedBefore && isReactivationOnly) {
        throw new BadRequestException(
          `This employee has left (${before.employmentStatus}). Change their employment status to a working one (for example Confirmed) to reinstate them.`,
        );
      }
      if (
        !isReactivationOnly &&
        !((reinstating || correctingExit) && statusOnly)
      ) {
        throw new BadRequestException(
          'This employee is deactivated — reactivate them first before making any other changes.',
        );
      }
    }
    if (reinstating) {
      // Bringing someone back counts as adding an employee (checked against the company's cap).
      await assertEmployeeRoom(organizationId);
      // Reopening the account is part of the same save, so the status and the account never disagree.
      Object.assign(clean, { isActive: true });
    }

    // Admin and HR can change an employee's status to any other at any time. The only thing that is not a plain
    // edit is leaving: Resigned (serving notice) and the final exits, for someone who is still working, go through
    // Resignation / Offboarding - they need a last working day and the clearance and settlement behind them, and
    // closing the account first would leave the final pay impossible to calculate.
    const statusChanging =
      clean.employmentStatus !== undefined &&
      clean.employmentStatus !== before.employmentStatus;
    // HR cannot move their own employment status (confirm their own probation, put themselves on hold or into
    // notice): another HR user or an Admin has to. An Admin is the top authority with no one above, so an Admin may -
    // same split as salary revision. The change is still in the status history and the audit log.
    if (statusChanging && actor.id === id && actor.role === Role.HR) {
      throw new ForbiddenException(
        'You cannot change your own employment status. An Admin or another HR user must do it.',
      );
    }
    const leaving =
      statusChanging &&
      LEAVING_STATUSES.includes(clean.employmentStatus as EmploymentStatus) &&
      !exitedBefore;
    if (leaving) {
      throw new BadRequestException(
        `Use Resignation or Offboarding to move an employee to ${clean.employmentStatus} - it records the last working day and runs the notice period, clearance and full & final settlement.`,
      );
    }
    // A closed account is not put into the notice stage (Resigned is for someone still working).
    if (
      exitedBefore &&
      statusChanging &&
      clean.employmentStatus === EmploymentStatus.RESIGNED
    ) {
      throw new BadRequestException(
        'Someone who has left cannot be set to Resigned (serving notice). Reinstate them to a working status first.',
      );
    }

    // probationStatus mirrors the employment status for the two probation outcomes, so the two never disagree.
    if (statusChanging && clean.employmentStatus === 'CONFIRMED') {
      Object.assign(clean, { probationStatus: 'CONFIRMED' });
    } else if (
      statusChanging &&
      clean.employmentStatus === 'EXTENDED_PROBATION'
    ) {
      Object.assign(clean, { probationStatus: 'EXTENDED' });
    }

    // An Admin reports to nobody: whenever the resulting role is Admin the reporting manager is cleared.
    if ((clean.role ?? before.role) === Role.ADMIN) {
      Object.assign(clean, { reportingManagerId: null, additionalReportingManagerIds: [] });
    } else if (clean.additionalReportingManagerIds !== undefined || clean.reportingManagerId) {
      // Extra managers: validated like the primary, never the person themself or the primary, no cycles. When only the
      // primary changes (an older client), a new primary that was already an extra manager is simply moved up.
      const primary = clean.reportingManagerId !== undefined ? clean.reportingManagerId : before.reportingManagerId;
      const wanted = clean.additionalReportingManagerIds ?? before.additionalReportingManagerIds ?? [];
      const extras = await this.cleanExtraManagers(wanted, primary, id, organizationId);
      for (const m of extras) await this.assertNoReportingCycle(id, m, organizationId);
      Object.assign(clean, { additionalReportingManagerIds: extras });
    }

    // Reporting manager: no self-reporting and no cycles in the chain.
    if (clean.reportingManagerId) {
      await this.assertNoReportingCycle(
        id,
        clean.reportingManagerId,
        organizationId,
      );
    }

    // Joining date: a one-time correction, never after payroll has been processed for the employee.
    const joiningDateChange = await this.assertJoiningDateChangeAllowed(
      before,
      clean.joiningDate,
      organizationId,
    );

    // Deactivating (not reactivating) someone who's still another active
    // employee's reportingManagerId requires reassigning those direct
    // reports first — otherwise they're left pointing at a manager who can
    // no longer even log in.
    if (clean.isActive === false && before.isActive) {
      // The registered account and the last active Admin must stay (Control Panel needs an active Admin per company).
      await assertAccountCanLeave(this.scopedPrisma, id, organizationId);
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
          joiningDate: clean.joiningDate
            ? new Date(clean.joiningDate)
            : undefined,
          joiningDateChangedAt: joiningDateChange ? new Date() : undefined,
          // Bringing someone back (or reopening the account) ends the exit: its last working day must stop hiding them
          // from the trackers and cutting their payroll short.
          ...(clean.isActive === true && !before.isActive ? { exitDate: null } : {}),
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

    if (joiningDateChange) {
      await this.syncAfterJoiningDateChange(
        before,
        joiningDateChange.newDate,
        actor,
        organizationId,
      );
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
      action: reinstating ? 'EMPLOYEE_REINSTATED' : 'EMPLOYEE_UPDATED',
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
  // mirrors the original release's logAudit-adjacent behavior. Silent no-op for
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

  private async assertAnotherActiveAdminRemains(
    id: string,
    organizationId: string,
  ) {
    const others = await this.scopedPrisma.user.count({
      where: {
        organizationId,
        role: Role.ADMIN,
        isActive: true,
        id: { not: id },
      },
    });
    if (others === 0) {
      throw new BadRequestException(
        'This is the only active Admin. Make another employee an Admin first, then change or deactivate this one.',
      );
    }
  }

  // Kept so the route answers clearly: an employee is never deactivated directly any more (see
  // DEACTIVATION_BLOCKED_MESSAGE). Closing the account is the last step of Offboarding, which settles the final pay
  // first and records the exit.
  // eslint-disable-next-line @typescript-eslint/require-await -- only ever throws, but stays async so callers get a rejected promise
  /** Reassign all of a manager's active reports (primary or additional) to a replacement manager at once. */
  async reassignAllReports(
    managerId: string,
    newManagerId: string,
    actor: Actor & { id: string },
    organizationId: string,
  ) {
    const manager = await this.scopedPrisma.user.findFirst({ where: { id: managerId, organizationId }, select: { id: true } });
    if (!manager) throw new NotFoundException('Employee not found.');
    return reassignReports(
      { scopedPrisma: this.scopedPrisma, timelineService: this.timelineService, auditLogService: this.auditLogService },
      managerId,
      newManagerId,
      organizationId,
      actor.id,
    );
  }

  async deactivate(
    id: string,
    dto: DeactivateEmployeeDto,
    actor: Actor & { id: string },
    organizationId: string,
  ): Promise<never> {
    void dto;
    void organizationId;
    if (actor.id === id) {
      throw new BadRequestException(
        'You cannot deactivate your own account — ask another Admin or HR to do it.',
      );
    }
    throw new BadRequestException(DEACTIVATION_BLOCKED_MESSAGE);
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

  // Returns the change descriptor when joiningDate really changes (null when it is absent/unchanged).
  // Allowed once per employee, and only while no payroll for them is past the editable
  // draft/calculated stage - a verified/approved/locked/paid run is final, so the date is frozen.
  private async assertJoiningDateChangeAllowed(
    before: {
      id: string;
      joiningDate: Date;
      joiningDateChangedAt: Date | null;
    },
    newDateStr: string | undefined,
    organizationId: string,
  ): Promise<{ newDate: string } | null> {
    if (!newDateStr) return null;
    const newDate = newDateStr.slice(0, 10);
    if (newDate === before.joiningDate.toISOString().slice(0, 10)) return null;
    if (before.joiningDateChangedAt) {
      throw new BadRequestException(
        'The joining date has already been changed once and cannot be changed again.',
      );
    }
    const processed = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        employeeId: before.id,
        status: {
          in: [
            PayrollRunStatus.VERIFIED,
            PayrollRunStatus.APPROVED,
            PayrollRunStatus.LOCKED,
            PayrollRunStatus.PAID,
          ],
        },
      },
      select: { id: true },
    });
    if (processed) {
      throw new BadRequestException(
        'The joining date cannot be changed after payroll has been processed for this employee.',
      );
    }
    return { newDate };
  }

  // Attendance and payroll are derived from the joining date: days before it have no attendance row, days from it
  // do. Re-aligns the rows (drops empty system rows before the new date, creates the ones the earlier date now
  // needs) and recalculates the employee's still-open payroll runs so payslips follow the new date.
  private async syncAfterJoiningDateChange(
    before: { id: string; joiningDate: Date },
    newDate: string,
    actor: Actor & { id: string; role: Role },
    organizationId: string,
  ) {
    const oldDate = before.joiningDate.toISOString().slice(0, 10);
    const orgRow = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const yesterday = addDaysStr(
      todayInOrgTz(orgRow?.timezone ?? 'Asia/Kolkata'),
      -1,
    );

    if (newDate > oldDate) {
      // Moved later: system-generated empty rows before the new date no longer belong.
      await this.scopedPrisma.attendance.deleteMany({
        where: {
          organizationId,
          employeeId: before.id,
          date: { lt: newDate },
          inTime: null,
          status: {
            in: [
              AttendanceStatus.ABSENT,
              AttendanceStatus.WEEKLY_OFF,
              AttendanceStatus.HOLIDAY,
            ],
          },
        },
      });
    } else {
      // Moved earlier: create the rows for newDate..(oldDate - 1) that the nightly sweep never wrote.
      const last =
        addDaysStr(oldDate, -1) < yesterday
          ? addDaysStr(oldDate, -1)
          : yesterday;
      const dates = enumerateDateStrings(newDate, last).slice(0, 366);
      // One query for the days that already have a row, then the missing ones a few at a time. This used to look each
      // day up on its own, write it one after another and - the real cost - send the employee a "marked absent"
      // notification and e-mail for every one of those past days, so a joining date moved back by months kept the
      // request busy for minutes (and the screen on its loader) and filled the employee's inbox. The rows are written
      // quietly now: these are not absences anyone needs to be told about.
      const have = new Set(
        (
          await this.scopedPrisma.attendance.findMany({
            where: {
              organizationId,
              employeeId: before.id,
              date: { gte: newDate, lte: last },
            },
            select: { date: true },
          })
        ).map((r) => r.date),
      );
      await mapWithConcurrency(
        dates.filter((d) => !have.has(d)),
        4,
        (date) =>
          this.attendanceService.recalculateAttendanceForDay(
            this.scopedPrisma,
            before.id,
            date,
            organizationId,
            { quiet: true },
          ),
      );
    }

    // The salary structure starts when the person joins: a component whose first row begins on the old joining date now
    // begins on the new one. Without this a revision effective from the new date was refused ("cannot start before the
    // current one"), because the structure still began on the date that had just been corrected. Only rows that start
    // exactly on the old date and are still in force on the new one are moved, so a later revision is never disturbed;
    // the date change is refused once any payroll is verified, so no signed-off month can be affected.
    await this.alignSalaryStructureStart(
      before.id,
      oldDate,
      newDate,
      actor.id,
      organizationId,
    );

    // Recalculate only the months that have an open (draft/calculated) payroll run in the affected range.
    const from = (newDate < oldDate ? newDate : oldDate).slice(0, 7);
    const to = (newDate < oldDate ? oldDate : newDate).slice(0, 7);
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId: before.id,
        isFinalSettlement: false,
        runSequence: 0,
        status: { in: [PayrollRunStatus.DRAFT, PayrollRunStatus.CALCULATED] },
      },
      select: { month: true, year: true },
    });
    for (const run of runs) {
      const key = `${run.year}-${String(run.month).padStart(2, '0')}`;
      if (key < from || key > to) continue;
      await this.payrollService.calculate(
        { employeeId: before.id, month: run.month, year: run.year },
        // calculate() only reads actor.id / actor.role, both present here.
        actor as unknown as Parameters<PayrollService['calculate']>[1],
        organizationId,
      );
    }
  }

  private async alignSalaryStructureStart(
    employeeId: string,
    oldDate: string,
    newDate: string,
    actorId: string,
    organizationId: string,
  ) {
    const rows = await this.scopedPrisma.employeeSalaryComponent.findMany({
      where: {
        organizationId,
        employeeId,
        effectiveFrom: oldDate,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: newDate } }],
      },
      select: { id: true, componentCode: true },
    });
    if (rows.length === 0) return;
    await this.scopedPrisma.employeeSalaryComponent.updateMany({
      where: { organizationId, id: { in: rows.map((r) => r.id) } },
      data: { effectiveFrom: newDate },
    });
    await this.auditLogService.log({
      actorId,
      action: 'EMPLOYEE_SALARY_START_ALIGNED',
      module: 'PAYROLL',
      organizationId,
      targetId: employeeId,
      details: {
        reason: 'Joining date corrected',
        from: oldDate,
        to: newDate,
        components: rows.map((r) => r.componentCode),
      },
    });
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

  // The additional reporting managers to store: each must be an active Admin, HR or Manager of this organisation; the
  // employee themself, the primary manager and duplicates are dropped.
  private async cleanExtraManagers(
    ids: string[] | undefined,
    primaryId: string | null | undefined,
    selfId: string | undefined,
    organizationId: string,
  ): Promise<string[]> {
    const wanted = [...new Set((ids ?? []).filter((x) => !!x && x !== selfId && x !== primaryId))];
    if (wanted.length === 0) return [];
    const found = await this.scopedPrisma.user.findMany({
      where: { id: { in: wanted }, organizationId, isActive: true },
      select: { id: true, role: true },
    });
    if (found.length !== wanted.length) {
      throw new BadRequestException('One of the additional reporting managers was not found.');
    }
    if (found.some((m) => m.role === Role.EMPLOYEE)) {
      throw new BadRequestException('Every reporting manager must be an Admin, HR or Manager.');
    }
    return wanted;
  }

  // departmentId / reportingManagerId must reference a row of the caller's
  // own organization. The FKs are on id alone, so without this a
  // Department/User id from another tenant was accepted and full-profile
  // then showed that org's department/manager names. Same 400 whether the
  // id doesn't exist at all or exists in another org — no existence oracle.
  private async assertOrgReferences(
    refs: {
      departmentId?: string | null;
      reportingManagerId?: string | null;
    },
    organizationId: string,
    // The manager already on the record — an unchanged legacy assignment (e.g.
    // a plain EMPLOYEE set before the role rule existed) must not block
    // unrelated edits, so the role check applies only to a new choice.
    currentManagerId?: string | null,
  ) {
    if (refs.departmentId) {
      const dept = await this.scopedPrisma.department.findFirst({
        where: { id: refs.departmentId, organizationId },
        select: { id: true },
      });
      if (!dept) {
        throw new BadRequestException(
          'The specified department was not found.',
        );
      }
    }
    if (refs.reportingManagerId) {
      const manager = await this.scopedPrisma.user.findFirst({
        where: { id: refs.reportingManagerId, organizationId },
        select: { id: true, role: true },
      });
      if (!manager) {
        throw new BadRequestException(
          'The specified reporting manager was not found.',
        );
      }
      // Only manager-level roles can approve/manage others, so a plain
      // EMPLOYEE is never a valid reporting manager.
      if (
        manager.role === Role.EMPLOYEE &&
        refs.reportingManagerId !== currentManagerId
      ) {
        throw new BadRequestException(
          'The reporting manager must be an Admin, HR or Manager.',
        );
      }
    }
  }

  // contactNumber is stored in two different shapes depending on who last
  // saved it — plain 10-digit from the admin Add/Edit Employee form, or
  // "+91 xxxxxxxxxx" from self-service My Profile's PhoneInput (see
  // EmployeeFullProfile.tsx's PHONE_KEYS comment for the same split) — so
  // an exact-string duplicate check would miss "+91 9876543210" matching
  // an existing plain "9876543210". Compare by the trailing 10 digits
  // instead, which is what actually identifies an Indian mobile number
  // regardless of which form last wrote it.
  private normalizeContactNumber(value: string): string {
    return value.replace(/\D/g, '').slice(-10);
  }

  // One contact number belongs to one person — same reasoning as the PAN/
  // UAN uniqueness check in employee-profile.service.ts, but contactNumber
  // lives as a plain column on User (not inside the encrypted personalData
  // blob), so this can query it directly instead of decrypting every row.
  // Scoped to this organization only, matching that same PAN/UAN
  // precedent — two different orgs' employees aren't the same tenant's
  // data and were never checked against each other for any other
  // identifier either.
  private async assertContactNumberUnique(
    contactNumber: string | undefined,
    organizationId: string,
    excludeId?: string,
  ): Promise<void> {
    if (!contactNumber) return;
    const normalized = this.normalizeContactNumber(contactNumber);
    if (normalized.length !== 10) return;
    const others = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        contactNumber: { not: '' },
        ...(excludeId && { id: { not: excludeId } }),
      },
      select: { contactNumber: true },
    });
    const clash = others.some(
      (u) => this.normalizeContactNumber(u.contactNumber) === normalized,
    );
    if (clash) {
      throw new ConflictException(
        'This contact number is already in use by another employee.',
      );
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
  // EMPLOYEE now reaches findAll too (Reporting Structure's org-chart view
  // is open to everyone) — mask personalData for anyone below HR/Admin
  // looking at someone else's row, not just MANAGER, or an employee
  // browsing that list would see every colleague's bank/PAN/Aadhar/address.
  return (
    actor.role !== Role.ADMIN && actor.role !== Role.HR && actor.id !== targetId
  );
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
    <p>Your account on ${company} HRMS is ready. Set your password with the link below, then sign in with your login email and that password:</p>
    <p>
      Login email: <strong>${escapeHtml(params.email)}</strong><br>
      Login URL: <a href="${loginUrl}">${loginUrl}</a><br>
      Employee ID (reference only): <strong>${escapeHtml(params.employeeId)}</strong>
    </p>
    <p><a href="${params.setPasswordUrl}">Set your password</a> (this link works once and expires in 7 days).</p>
  `;
}

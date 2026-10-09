import { IsIndianMobile } from '../../common/indian-mobile';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  EmploymentStatus,
  Gender,
  Role,
  SelfieRequirement,
} from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';
import { NormalizeEmail, Trim } from '../../common/normalize-input';
import { IsReasonableJoiningDate } from '../../common/is-reasonable-joining-date.validator';
import {
  PERSON_NAME_MAX_LENGTH,
  PERSON_NAME_MESSAGE,
  PERSON_NAME_PATTERN,
} from '../../common/person-name';

// Note: employeeId is deliberately not editable through this DTO at all
// (not even by HR/Admin) — unlike the old system, which technically
// allowed it via LOCKED_FIELDS_FOR_EMPLOYEE's asymmetric self-vs-HR split.
// It's auto-generated and uniquely constrained per org; a general update
// endpoint isn't the right place to let it be hand-edited.
export class UpdateEmployeeDto {
  // Trimmed + non-empty when present: a whitespace-only name used to be
  // stored as-is.
  @ApiPropertyOptional()
  @Trim()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PERSON_NAME_MAX_LENGTH)
  @Matches(PERSON_NAME_PATTERN, { message: `name ${PERSON_NAME_MESSAGE}` })
  name?: string;

  // Locked for self-update — see employee-field-lock.ts.
  @ApiPropertyOptional()
  @NormalizeEmail()
  @IsOptional()
  @IsEmail()
  email?: string;

  // Corporate inbox, usually set well after creation once IT provisions it
  // — self-editable (not in LOCKED_FIELDS_FOR_EMPLOYEE), unlike the login
  // email above. See officialEmail's comment on the User model. The edit
  // form always round-trips this field, blank or not, so '' (not yet
  // provisioned) has to stay valid — @IsOptional alone only skips
  // validation for undefined, not ''.
  @ApiPropertyOptional()
  @NormalizeEmail()
  @IsOptional()
  @ValidateIf((o: UpdateEmployeeDto) => o.officialEmail !== '')
  @IsEmail()
  officialEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({
    description:
      "Per-employee work location override (geo-fence + state). Falls back to the department's location when unset; null clears the override.",
  })
  @IsOptional()
  @IsUUID()
  workLocationId?: string | null;

  @ApiPropertyOptional({
    description:
      'Per-employee, not org-wide: when true, this employee must have an effective work location (own or department) to punch in/out — see AttendanceService.selfPunch. Off by default; turn on for an office-based employee, leave off for remote/field staff.',
  })
  @IsOptional()
  @IsBoolean()
  requireWorkLocationForPunch?: boolean;

  // HR/Admin only (see employee-field-lock.ts).
  @ApiPropertyOptional({ enum: SelfieRequirement })
  @IsOptional()
  @IsEnum(SelfieRequirement)
  selfieRequirement?: SelfieRequirement;

  // Locked for self-update, AND locked for HR (Admin only) — mirrors the
  // old system exactly: even hr_admin couldn't change designation.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  designation?: string;

  // Locked for self-update (see employee-field-lock.ts) but, unlike
  // designation, HR can set these too — no old-system precedent restricting
  // them to Admin-only.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeCategory?: string;

  // Not format-validated — Profile.tsx's self-service edit sends this via
  // PhoneInput as "+<dialcode> <national>" (e.g. "+91 9876543210"), while
  // the admin "Add/Edit Employee" form sends plain 10-digit input (see
  // create-employee.dto.ts's sibling field). A single regex can't satisfy
  // both real, already-shipped formats on this one shared column.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  // Indian mobile (10 digits, first digit 6-9, optional +91) - same rule as the PhoneInput on every screen.
  @IsIndianMobile()
  contactNumber?: string;

  // Self-editable — feeds LeaveType.applicableGenders eligibility filtering
  // (leave-eligibility.ts), which has no other way to be set.
  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional()
  @IsOptional()
  @IsReasonableJoiningDate()
  joiningDate?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  @ApiPropertyOptional({ enum: EmploymentStatus })
  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;

  // Missing from this DTO entirely until now — the Edit Employee form
  // always sends it (create and edit share one payload builder on the
  // frontend), so every edit save 400'd with "property employeeType
  // should not exist" (forbidNonWhitelisted). Locked for self-update, same
  // tier as designation/gradeLevel/employeeCategory — see
  // employee-field-lock.ts.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Standing opt-out from bulk payroll runs — see the User.excludeFromPayroll
  // schema comment. A plain flag with no side effects (unlike isActive
  // above), so no special-casing needed in EmployeesService.update().
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  excludeFromPayroll?: boolean;

  // Exempt from the Labour Welfare Fund (managerial, or supervisory above the wage limit) — see the User.lwfExempt
  // schema comment. HR/Admin only, via the field lock below.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  lwfExempt?: boolean;

  // Durable relativeKey from POST /files/upload/profile-photos — never a
  // signed URL (see file-token.ts). Self-editable, not in the HR-only
  // locked-fields list.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  profileImage?: string;

  // Only consulted when this update flips isActive true -> false and the
  // employee being deactivated is currently the reportingManagerId of at
  // least one other active employee — required in that case (the service
  // rejects the deactivation otherwise) so those direct reports are never
  // left pointing at a manager who can no longer log in. Not a persisted
  // column on User itself; see EmployeesService.update().
  @ApiPropertyOptional({
    description:
      "Required when deactivating (isActive:false) an employee who is still another employee's reportingManagerId — the id of the replacement manager to reassign those direct reports to.",
  })
  @IsOptional()
  @IsUUID()
  reassignManagerId?: string;

  // Movement-history metadata (never persisted on User) — recorded on the EmployeeMovement row(s) written
  // when departmentId / designation / gradeLevel / reportingManagerId changes. The change itself is applied
  // immediately; effectiveDate is history-only (no future-dated application). Defaults to today.
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsValidCalendarDateString()
  effectiveDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;

  // Flags a designation/grade change as a promotion (PROMOTION movement + timeline event) rather than a
  // plain DESIGNATION_CHANGE.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPromotion?: boolean;
}

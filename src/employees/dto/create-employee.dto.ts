import { IsIndianMobile } from '../../common/indian-mobile';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, IsArray, ArrayMaxSize } from 'class-validator';
import { Gender, LocationRequirement, Role, SelfieRequirement } from '@prisma/client';
import { NormalizeEmail, Trim } from '../../common/normalize-input';
import { IsReasonableJoiningDate } from '../../common/is-reasonable-joining-date.validator';
import {
  PERSON_NAME_MAX_LENGTH,
  PERSON_NAME_MESSAGE,
  PERSON_NAME_PATTERN,
} from '../../common/person-name';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Jane Employee' })
  @Trim()
  @IsNotEmpty()
  @IsString()
  @MaxLength(PERSON_NAME_MAX_LENGTH)
  @Matches(PERSON_NAME_PATTERN, { message: `name ${PERSON_NAME_MESSAGE}` })
  name!: string;

  @ApiProperty({ example: 'jane@acme.test' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  // Optional at this DTO/type level so bulkCreate's row shape (no
  // per-row personalEmail column in the Excel import) keeps working
  // unchanged — the single "Add Employee" form enforces it as required
  // client-side instead, since that's the flow this actually matters for.
  // When present, EmployeesService.create() routes it into personalData and
  // sends the welcome email (login URL, login email, employee ID for reference, and a set-password link);
  // when absent (bulk-imported rows), no email is sent, matching today's
  // fallback of returning the password in the response only.
  // '' and absent are both "don't send a welcome email" to
  // EmployeesService.create()'s truthy checks, so '' has to stay valid —
  // @IsOptional alone only skips validation for undefined, same class of
  // bug as SendNotificationDto.department.
  @ApiPropertyOptional({ example: 'jane.personal@gmail.com' })
  @NormalizeEmail()
  @IsOptional()
  @ValidateIf((o: CreateEmployeeDto) => o.personalEmail !== '')
  @IsEmail()
  personalEmail?: string;

  // Department, designation, employee category and work location are required - the Add Employee form and the
  // Excel import enforce the same four, so an employee cannot be created without them from any client.
  @ApiProperty({ description: 'Department the employee belongs to.' })
  @IsNotEmpty({ message: 'Department is required.' })
  @IsUUID()
  departmentId!: string;

  @ApiProperty({
    description:
      "Work location (geo-fence + state). Required; an employee's own location overrides the department's.",
  })
  @IsNotEmpty({ message: 'Work location is required.' })
  @IsUUID()
  workLocationId!: string;

  @ApiPropertyOptional({
    description:
      'Per-employee, not org-wide: when true, this employee must have an effective work location (own or department) to punch in/out — see AttendanceService.selfPunch. Off by default; turn on for an office-based employee, leave off for remote/field staff.',
  })
  @IsOptional()
  @IsBoolean()
  requireWorkLocationForPunch?: boolean;

  @ApiPropertyOptional({
    enum: SelfieRequirement,
    default: SelfieRequirement.DEFAULT,
    description:
      'Selfie at check-in/out: DEFAULT follows the org setting; REQUIRED / NOT_REQUIRED override it for this employee.',
  })
  @IsOptional()
  @IsEnum(SelfieRequirement)
  selfieRequirement?: SelfieRequirement;

  @ApiPropertyOptional({
    enum: LocationRequirement,
    default: LocationRequirement.DEFAULT,
    description:
      'Location at check-in/out: DEFAULT follows the org setting; ENFORCED (inside the work location), RECORD_ONLY (stored, never blocks) or NOT_NEEDED (selfie only) override it for this employee.',
  })
  @IsOptional()
  @IsEnum(LocationRequirement)
  locationRequirement?: LocationRequirement;

  @ApiProperty()
  @Trim()
  @IsNotEmpty({ message: 'Designation is required.' })
  @IsString()
  @MaxLength(100)
  designation!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiProperty()
  @Trim()
  @IsNotEmpty({ message: 'Employee category is required.' })
  @IsString()
  employeeCategory!: string;

  // Not format-validated here — this endpoint (admin "Add Employee") always
  // gets plain 10-digit input from the frontend, but Profile.tsx's own
  // self-service edit sends this same field through PhoneInput as
  // "+<dialcode> <national>" (e.g. "+91 9876543210") via PATCH
  // /employees/:id, which shares this DTO's sibling in update-employee.dto.
  // A digits-only regex here would reject every legitimate self-edit.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  // Indian mobile (10 digits, first digit 6-9, optional +91) - same rule as the PhoneInput on every screen.
  @IsIndianMobile()
  contactNumber?: string;

  // Optional at this DTO/type level for the same reason as personalEmail —
  // the manual "Add Employee" form and bulkCreate's row validation both
  // enforce it as required client/row-side. Feeds
  // LeaveType.applicableGenders eligibility (leave-eligibility.ts), which
  // has no other way to be set at creation time.
  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional()
  @IsOptional()
  @IsReasonableJoiningDate()
  joiningDate?: string;

  @ApiPropertyOptional({
    enum: Role,
    description: 'Defaults to EMPLOYEE. HR cannot assign ADMIN.',
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  // Further managers beyond the primary one (the "Reporting managers" multi-select: the first pick is the primary, the rest
  // are listed here). They can approve and are notified like the primary. An Admin reports to nobody, so it is cleared then.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  additionalReportingManagerIds?: string[];

  @ApiPropertyOptional({ example: 'permanent' })
  @IsOptional()
  @IsString()
  employeeType?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { EmploymentStatus, Gender, Role } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// Note: employeeId is deliberately not editable through this DTO at all
// (not even by HR/Admin) — unlike the old system, which technically
// allowed it via LOCKED_FIELDS_FOR_EMPLOYEE's asymmetric self-vs-HR split.
// It's auto-generated and uniquely constrained per org; a general update
// endpoint isn't the right place to let it be hand-edited.
export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  // Locked for self-update — see employee-field-lock.ts.
  @ApiPropertyOptional()
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
  @IsOptional()
  @ValidateIf((o: UpdateEmployeeDto) => o.officialEmail !== '')
  @IsEmail()
  officialEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  // Locked for self-update, AND locked for HR (Admin only) — mirrors the
  // old system exactly: even hr_admin couldn't change designation.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactNumber?: string;

  // Self-editable — feeds LeaveType.applicableGenders eligibility filtering
  // (leave-eligibility.ts), which has no other way to be set.
  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional()
  @IsOptional()
  @IsValidCalendarDateString()
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
}

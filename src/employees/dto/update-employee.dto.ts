import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { EmploymentStatus, Gender, Role } from '@prisma/client';

// Note: employeeId is deliberately not editable through this DTO at all
// (not even by HR/Admin) — unlike the old system, which technically
// allowed it via LOCKED_FIELDS_FOR_EMPLOYEE's asymmetric self-vs-HR split.
// It's auto-generated and uniquely constrained per org; a general update
// endpoint isn't the right place to let it be hand-edited.
export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  // Locked for self-update — see employee-field-lock.ts.
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

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
  @IsDateString()
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
}

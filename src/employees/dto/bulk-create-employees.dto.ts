import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
} from 'class-validator';

// Deliberately loose/untyped per-field validation — same reasoning as
// ImportRowDto (attendance) and BulkImportHolidaysDto's rows: this is a
// row-level fail-but-continue import, so a single malformed row (missing
// name, bad email) must land in bulkCreate()'s `failed` array rather than
// rejecting the entire batch with a 400 before it even reaches the service.
// Real validation happens row-by-row in EmployeesService.bulkCreate.
// @IsOptional() (with no type-specific validator) is what makes
// class-validator's `whitelist: true` recognize these as known DTO
// properties — an @ApiProperty()-only field with zero validator decorators
// gets silently stripped by whitelist, then rejected by
// forbidNonWhitelisted as an "unrecognized" property.
class BulkEmployeeRowDto {
  @ApiProperty()
  @IsOptional()
  name!: unknown;

  @ApiProperty()
  @IsOptional()
  email!: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  designation?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  contactNumber?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  gender?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  joiningDate?: unknown;

  // Matches the manual "Add Employee" form's own required fields — see
  // EmployeesService.bulkCreate's row-by-row validation, which requires
  // these the same way the form does (department/employeeCategory/
  // employeeType matched by name/value against the org's actual lists,
  // role matched against the Role enum). personalEmail is what makes the
  // welcome email actually send for bulk-imported rows, same as the manual
  // form's Personal Email field.
  @ApiPropertyOptional()
  @IsOptional()
  personalEmail?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  department?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  employeeCategory?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  role?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  employeeType?: unknown;
}

export class BulkCreateEmployeesDto {
  @ApiProperty({ type: [BulkEmployeeRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkEmployeeRowDto)
  rows!: BulkEmployeeRowDto[];

  // Batch-level choice (default true), not per-row — mirrors the manual "Add
  // Employee" form's Email/No-email radio, but applied once to the whole
  // import instead of once per employee. When false, EmployeesService.create()
  // still creates every row and generates a password as normal; it just
  // never sends the welcome email for this batch, and bulkCreate() surfaces
  // each row's generatedPassword in `created` so the caller can hand it out
  // directly (see the "Download Credentials" flow in Employees.tsx).
  @ApiPropertyOptional({
    default: true,
    description:
      'Whether to email each imported employee their welcome/set-password link. Defaults to true. When false, generated passwords are returned in the response instead.',
  })
  @IsOptional()
  @IsBoolean()
  sendWelcomeEmail?: boolean;
}

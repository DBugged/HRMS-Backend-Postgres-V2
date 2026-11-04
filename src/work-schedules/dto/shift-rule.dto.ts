import { Gender } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Create and update share one shape; on update every field is optional.
export class SaveShiftRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @Matches(HHMM, { message: 'startTime must be HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'endTime must be HH:MM.' })
  endTime?: string;

  // Null/left out = the department's own break.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(240)
  breakMinutes?: number | null;

  // Empty = every department.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  // Names the people this shift is for; then gender and departments do not apply.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RecalculateShiftRulesDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD.' })
  from!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(Gender, { each: true })
  genders?: Gender[];

  // People named by a per-person rule.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds?: string[];

  // Empty = every department.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];
}

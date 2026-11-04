import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// Create and update share one shape; on update every field is optional.
export class SaveOvertimeRuleSetDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  // Same keys as the company overtime policy; any key left out falls back to the company value.
  @IsOptional()
  @IsObject()
  policy?: Record<string, unknown>;

  // Pay multipliers per overtime type (REGULAR, WEEKEND, HOLIDAY, NIGHT); left out = the Payroll Settings rate.
  @IsOptional()
  @IsObject()
  rates?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  designations?: string[];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveFrom must be YYYY-MM-DD.',
  })
  effectiveFrom?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PreviewOvertimeRuleDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

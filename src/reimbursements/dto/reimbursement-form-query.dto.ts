import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ReimbursementFormQueryDto {
  @ApiProperty({ example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  // Admin/HR only: employee ids (comma-separated). Left out = every employee with claims that month. Anyone else only
  // ever gets their own form.
  @ApiPropertyOptional({ description: 'Comma-separated employee UUIDs (Admin/HR)' })
  @IsOptional()
  @IsString()
  employeeIds?: string;

  // The form is a PDF by default; Excel is available for anyone who wants to edit it.
  @ApiPropertyOptional({ enum: ['pdf', 'xlsx'], default: 'pdf' })
  @IsOptional()
  @IsIn(['pdf', 'xlsx'])
  format?: 'pdf' | 'xlsx';
}

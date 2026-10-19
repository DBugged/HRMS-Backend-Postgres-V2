import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Allow,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
} from 'class-validator';

// One line of the migration sheet. Kept loose on purpose (plain values, no per-field validators): a bad cell must come
// back as a message against its own row in the result, not fail the whole request.
export class ImportLeaveRowDto {
  @ApiProperty({ description: 'Employee code, e.g. DP-00005' })
  @Allow()
  employeeId!: unknown;

  @ApiProperty({ description: 'Leave type code or name' })
  @Allow()
  leaveType!: unknown;

  @ApiProperty({ example: '2026-06-10' })
  @Allow()
  startDate!: unknown;

  @ApiProperty({ example: '2026-06-12' })
  @Allow()
  endDate!: unknown;

  @ApiPropertyOptional({ description: 'yes / no' })
  @IsOptional()
  @Allow()
  halfDay?: unknown;

  @ApiPropertyOptional({ description: 'first / second half, for a half day' })
  @IsOptional()
  @Allow()
  session?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  reason?: unknown;
}

export class ImportLeavesDto {
  @ApiProperty({ type: [ImportLeaveRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportLeaveRowDto)
  rows!: ImportLeaveRowDto[];

  @ApiPropertyOptional({
    description: 'true (default) = check only, nothing is saved',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

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

// One line of the Work From Home migration sheet. Kept loose on purpose (plain values, no per-field validators): a bad
// cell must come back as a message against its own row in the result, not fail the whole request.
export class ImportWfhRowDto {
  @ApiProperty({ description: 'Employee code, e.g. DP-00005' })
  @Allow()
  employeeId!: unknown;

  @ApiProperty({ example: '2026-06-10' })
  @Allow()
  fromDate!: unknown;

  @ApiPropertyOptional({
    example: '2026-06-12',
    description: 'Last day; blank = the same day as fromDate',
  })
  @IsOptional()
  @Allow()
  toDate?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  reason?: unknown;
}

export class ImportWfhDto {
  @ApiProperty({ type: [ImportWfhRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportWfhRowDto)
  rows!: ImportWfhRowDto[];

  @ApiPropertyOptional({
    description: 'true (default) = check only, nothing is saved',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

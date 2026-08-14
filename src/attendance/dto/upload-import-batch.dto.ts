import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// Deliberately loose/untyped per-field validation — these are raw parsed
// spreadsheet cells (same reasoning as BulkImportHolidaysDto's rows), real
// validation happens row-by-row in AttendanceService.validateImportBatch.
// @IsOptional() (with no type-specific validator) is what makes
// class-validator's `whitelist: true` recognize these as known DTO
// properties — an @ApiProperty()-only field with zero validator decorators
// gets silently stripped by whitelist, then rejected by
// forbidNonWhitelisted as an "unrecognized" property.
export class ImportRowDto {
  @ApiProperty()
  @IsOptional()
  employeeId!: unknown;

  @ApiProperty()
  @IsOptional()
  date!: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  inTime?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  outTime?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  inLocation?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  outLocation?: unknown;
}

export class UploadImportBatchDto {
  @ApiProperty({ type: [ImportRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows!: ImportRowDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fileName?: string;
}

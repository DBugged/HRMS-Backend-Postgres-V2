import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';

// Deliberately permissive at the DTO level (raw strings, no per-field
// class-validator rules) — the authoritative validation is
// HolidaysService.bulkImport's per-row pass, which mirrors the old
// controller's fail-but-continue behavior (invalid rows are collected into
// `failed`, not rejected as a 400 for the whole batch).
export class BulkImportHolidayRowDto {
  // @IsOptional() (with no type-specific validator) is what actually makes
  // class-validator's `whitelist: true` recognize these as known DTO
  // properties — an @ApiProperty()-only field with zero validator
  // decorators gets silently stripped by whitelist, then rejected by
  // forbidNonWhitelisted as an "unrecognized" property. name/date are only
  // logically required; that's enforced in HolidaysService.bulkImport's
  // per-row pass, not here (deliberately permissive at the DTO level).
  @ApiProperty()
  @IsOptional()
  name!: unknown;

  @ApiProperty()
  @IsOptional()
  date!: unknown;

  @ApiProperty({ required: false })
  @IsOptional()
  description?: unknown;

  @ApiProperty({ required: false })
  @IsOptional()
  type?: unknown;

  @ApiProperty({ required: false })
  @IsOptional()
  rowNum?: unknown;
}

export class BulkImportHolidaysDto {
  @ApiProperty({ type: [BulkImportHolidayRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkImportHolidayRowDto)
  rows!: BulkImportHolidayRowDto[];
}

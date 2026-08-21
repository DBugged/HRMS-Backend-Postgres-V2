import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
  joiningDate?: unknown;
}

export class BulkCreateEmployeesDto {
  @ApiProperty({ type: [BulkEmployeeRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkEmployeeRowDto)
  rows!: BulkEmployeeRowDto[];
}

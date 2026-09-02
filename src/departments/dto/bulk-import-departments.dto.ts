import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// One row from the parsed Excel/CSV sheet — parsing happens client-side
// (same xlsx-in-the-browser path as DocumentRequirement/OrgListItem's
// bulk import), so this DTO only ever sees plain {name, code, description}
// rows, never a raw file.
class DepartmentImportRow {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

export class BulkImportDepartmentsDto {
  @ApiProperty({ type: [DepartmentImportRow] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DepartmentImportRow)
  rows!: DepartmentImportRow[];
}

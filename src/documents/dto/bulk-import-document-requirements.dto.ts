import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// One row from the parsed Excel/CSV sheet — parsing (xlsx -> JSON) happens
// client-side, same as EnterpriseTable's existing export path, so this DTO
// only ever sees plain {name, isMandatory} rows, never a raw file.
class DocumentRequirementImportRow {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ default: false })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;
}

export class BulkImportDocumentRequirementsDto {
  @ApiProperty({ type: [DocumentRequirementImportRow] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DocumentRequirementImportRow)
  rows!: DocumentRequirementImportRow[];
}

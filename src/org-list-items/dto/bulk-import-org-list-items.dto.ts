import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { OrgListType } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsString,
  ValidateNested,
} from 'class-validator';

// One row from the parsed Excel/CSV sheet — parsing happens client-side
// (same xlsx-in-the-browser path as DocumentRequirement's bulk import), so
// this DTO only ever sees a plain {name} row, never a raw file.
class OrgListItemImportRow {
  @ApiProperty()
  @IsString()
  name!: string;
}

export class BulkImportOrgListItemsDto {
  @ApiProperty({ enum: OrgListType })
  @IsEnum(OrgListType)
  type!: OrgListType;

  @ApiProperty({ type: [OrgListItemImportRow] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrgListItemImportRow)
  rows!: OrgListItemImportRow[];
}

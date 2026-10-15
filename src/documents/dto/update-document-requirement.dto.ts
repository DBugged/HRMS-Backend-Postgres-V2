import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional } from 'class-validator';
import { DocumentName } from './document-name';

export class UpdateDocumentRequirementDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @DocumentName()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  // Soft-disable toggle used for "Disable" in the UI — not a delete.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  displayOrder?: number;
}

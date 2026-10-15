import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional } from 'class-validator';
import { DocumentName } from './document-name';

export class CreateDocumentRequirementDto {
  @ApiProperty({ maxLength: 100 })
  @DocumentName()
  name!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional({
    description:
      'Defaults to the current requirement count (appended to the end).',
  })
  @IsOptional()
  @IsInt()
  displayOrder?: number;
}

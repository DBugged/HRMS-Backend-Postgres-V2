import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateDocumentRequirementDto {
  @ApiProperty()
  @IsString()
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

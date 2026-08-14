import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  Matches,
  ValidateNested,
} from 'class-validator';
import { SetComponentValueDto } from './set-component-value.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BulkSetStructureDto {
  @ApiProperty({ type: [SetComponentValueDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SetComponentValueDto)
  lines!: SetComponentValueDto[];

  @ApiPropertyOptional({
    description:
      'Shared effectiveFrom for every line — defaults to today if omitted',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'effectiveFrom must be in YYYY-MM-DD format' })
  effectiveFrom?: string;
}

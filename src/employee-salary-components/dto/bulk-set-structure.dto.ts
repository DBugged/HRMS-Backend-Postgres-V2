import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { SetComponentValueDto } from './set-component-value.dto';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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
  @IsValidCalendarDateString()
  effectiveFrom?: string;
}

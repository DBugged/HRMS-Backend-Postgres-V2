import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class SubmitResignationDto {
  @ApiProperty({
    example: '2026-11-30',
    description: 'Last working day the employee is asking for.',
  })
  @IsValidCalendarDateString()
  requestedLwd!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Notice period (days) the employee believes applies.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;
}

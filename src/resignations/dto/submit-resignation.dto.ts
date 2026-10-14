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

  @ApiProperty({
    example: 30,
    description:
      "Notice period (days) the employee is serving. Required; the form starts at the organization's default notice period and may be raised, never set below it.",
  })
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays!: number;
}

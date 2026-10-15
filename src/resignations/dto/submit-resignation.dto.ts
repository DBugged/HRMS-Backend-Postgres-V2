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
    example: 30,
    description:
      "Ignored. The notice period is the organization's default notice period and is set by the server; an employee cannot choose it. Still accepted so an older app that sends it does not fail.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;
}

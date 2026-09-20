import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class ApproveResignationDto {
  @ApiPropertyOptional({
    example: '2026-11-30',
    description:
      'Approved last working day. Defaults to submittedOn + noticePeriodDays, or the requested LWD when no notice period is known.',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  approvedLwd?: string;

  @ApiPropertyOptional({
    description: 'Overrides the notice period (days) on the request.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionNote?: string;
}

export class RejectResignationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionNote?: string;
}

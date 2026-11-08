import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsNotEmpty,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class ApproveResignationDto {
  @ApiPropertyOptional({
    example: '2026-11-30',
    description:
      'Approved last working day. Defaults to the last working day the employee requested. A date before the notice period ends needs a decisionNote.',
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
  @ApiProperty({ description: 'Why the resignation is rejected; shown to the employee.' })
  @IsString()
  @IsNotEmpty({ message: 'Add a reason for rejecting the resignation.' })
  @MaxLength(1000)
  decisionNote!: string;
}

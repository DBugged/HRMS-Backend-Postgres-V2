import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// HR or an Admin records a resignation the employee gave outside the system (by email, in person).
export class RecordResignationDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({
    example: '2026-10-14',
    description:
      'The day the resignation was received (not in the future). Defaults to today.',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  receivedOn?: string;

  @ApiProperty({
    example: '2026-11-30',
    description: 'Last working day the employee asked for.',
  })
  @IsValidCalendarDateString()
  requestedLwd!: string;

  @ApiPropertyOptional({ description: 'Notice period (days) that applies.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Note: how it was received, and the reason given.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Approve it straight away (opens the offboarding case and starts the notice stage). Otherwise it is recorded as Pending.',
  })
  @IsOptional()
  @IsBoolean()
  approveNow?: boolean;
}

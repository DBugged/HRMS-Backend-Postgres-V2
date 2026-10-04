import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class BackfillAttendanceDto {
  @ApiProperty({ description: 'First date to fill, YYYY-MM-DD' })
  @IsValidCalendarDateString()
  startDate!: string;

  @ApiProperty({
    description: 'Last date to fill, YYYY-MM-DD (not later than yesterday)',
  })
  @IsValidCalendarDateString()
  endDate!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'true (default) only reports what would be created; send false to actually create the missing records',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

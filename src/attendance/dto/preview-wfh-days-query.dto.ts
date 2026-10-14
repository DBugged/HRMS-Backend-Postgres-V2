import { ApiProperty } from '@nestjs/swagger';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// Query of GET /attendance/work-arrangement/preview-days.
export class PreviewWfhDaysQueryDto {
  @ApiProperty({ example: '2026-10-26' })
  @IsValidCalendarDateString()
  from!: string;

  @ApiProperty({ example: '2026-10-28' })
  @IsValidCalendarDateString()
  to!: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class NotifyAbsenteesDto {
  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD of a finished day (not later than yesterday); defaults to yesterday',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  date?: string;
}

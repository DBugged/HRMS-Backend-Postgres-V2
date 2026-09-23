import { ApiProperty } from '@nestjs/swagger';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class TeamCalendarQueryDto {
  @ApiProperty({ example: '2026-06-01' })
  @IsValidCalendarDateString()
  from!: string;

  @ApiProperty({ example: '2026-06-30' })
  @IsValidCalendarDateString()
  to!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// Early release / extension: the case's last working day is changed (a linked draft settlement is unlinked so it is
// recalculated for the new date).
export class UpdateLastWorkingDayDto {
  @ApiProperty({ example: '2026-11-15' })
  @IsValidCalendarDateString()
  lastWorkingDay!: string;

  @ApiProperty({
    description: 'Why the date changed (early release, extended notice, ...).',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

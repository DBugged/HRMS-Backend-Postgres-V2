import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { WorkArrangement } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class SetWorkArrangementDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, defaults to today' })
  @IsOptional()
  @IsValidCalendarDateString()
  date?: string;

  @ApiProperty({ enum: WorkArrangement })
  @IsEnum(WorkArrangement)
  workArrangement!: WorkArrangement;

  @ApiPropertyOptional({
    description:
      'Last day of a multi-day Work From Home request (YYYY-MM-DD), with `date` as the first. Only the working days in the range are requested - weekly offs, holidays and leave days are left out - and they are reviewed together as one request. Up to 31 calendar days.',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  endDate?: string;
}

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
}

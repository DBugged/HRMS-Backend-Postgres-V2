import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Max, Min } from 'class-validator';
import { OvertimeType } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class LogOvertimeDto {
  @ApiProperty({ example: '2026-08-14' })
  @IsValidCalendarDateString()
  date!: string;

  @ApiProperty({ description: '0 < hours <= 24' })
  @Min(0.01)
  @Max(24)
  hours!: number;

  @ApiPropertyOptional({ enum: OvertimeType, default: OvertimeType.REGULAR })
  @IsOptional()
  @IsEnum(OvertimeType)
  type?: OvertimeType;
}

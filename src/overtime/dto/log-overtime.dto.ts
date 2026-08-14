import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches, Max, Min } from 'class-validator';
import { OvertimeType } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class LogOvertimeDto {
  @ApiProperty({ example: '2026-08-14' })
  @Matches(DATE_RE, { message: 'date must be in YYYY-MM-DD format' })
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

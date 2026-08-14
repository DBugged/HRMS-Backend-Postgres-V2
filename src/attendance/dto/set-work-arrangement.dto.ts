import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { WorkArrangement } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SetWorkArrangementDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, defaults to today' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;

  @ApiProperty({ enum: WorkArrangement })
  @IsEnum(WorkArrangement)
  workArrangement!: WorkArrangement;
}

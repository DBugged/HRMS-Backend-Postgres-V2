import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class NotifyAbsenteesDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, defaults to today' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;
}

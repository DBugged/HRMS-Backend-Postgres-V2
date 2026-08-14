import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class TeamCalendarQueryDto {
  @ApiProperty({ example: '2026-06-01' })
  @Matches(DATE_RE, { message: 'from must be in YYYY-MM-DD format' })
  from!: string;

  @ApiProperty({ example: '2026-06-30' })
  @Matches(DATE_RE, { message: 'to must be in YYYY-MM-DD format' })
  to!: string;
}

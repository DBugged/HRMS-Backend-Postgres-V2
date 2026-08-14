import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateDelegationDto {
  @ApiProperty()
  @IsUUID()
  delegate!: string;

  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'fromDate must be in YYYY-MM-DD format' })
  fromDate!: string;

  @ApiProperty({ example: '2026-06-20' })
  @Matches(DATE_RE, { message: 'toDate must be in YYYY-MM-DD format' })
  toDate!: string;

  // Only honored when the caller is ADMIN/HR — HR setting up a delegation
  // on a manager's behalf. Ignored (forced to the caller's own id)
  // otherwise, same as the old system.
  @ApiPropertyOptional({
    description: 'ADMIN/HR only: set up a delegation on behalf of this user',
  })
  @IsOptional()
  @IsUUID()
  delegator?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class CreateDelegationDto {
  @ApiProperty()
  @IsUUID()
  delegate!: string;

  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
  fromDate!: string;

  @ApiProperty({ example: '2026-06-20' })
  @IsValidCalendarDateString()
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

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class QueryDelegationDto {
  // ADMIN/HR only: view a specific user's delegations instead of the
  // caller's own.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  delegator?: string;
}

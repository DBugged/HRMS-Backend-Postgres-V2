import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class RunAccrualDto {
  @ApiPropertyOptional({
    description:
      'Preview only - lists the credits that would be made, changes nothing',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ description: 'Limit the run to one leave type' })
  @IsOptional()
  @IsUUID()
  leaveTypeId?: string;
}

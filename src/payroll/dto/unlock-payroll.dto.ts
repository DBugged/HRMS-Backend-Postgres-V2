import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UnlockPayrollDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

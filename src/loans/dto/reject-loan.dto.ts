import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RejectLoanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

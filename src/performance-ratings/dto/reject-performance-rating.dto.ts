import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RejectPerformanceRatingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

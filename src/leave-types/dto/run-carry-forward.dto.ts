import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional } from 'class-validator';

export class RunCarryForwardDto {
  @ApiPropertyOptional({
    description: 'Closing year to roll from — defaults to the current year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}

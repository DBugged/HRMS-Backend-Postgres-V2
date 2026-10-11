import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class TransitionLeaveYearDto {
  @ApiProperty({
    minimum: 1,
    maximum: 12,
    description: 'Month the leave year starts (1 = January = calendar year)',
  })
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth!: number;

  // Preview: nothing is changed, the result says what would be.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export class ProbationDecisionDto {
  @ApiProperty({ enum: ['confirmed', 'extended'] })
  @IsIn(['confirmed', 'extended'])
  decision!: 'confirmed' | 'extended';

  @ApiPropertyOptional({ description: 'Required when decision=extended.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'newProbationEndDate must be in YYYY-MM-DD format',
  })
  newProbationEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

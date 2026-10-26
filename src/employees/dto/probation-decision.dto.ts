import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Date a confirmation takes effect (YYYY-MM-DD) - between joining and today. Recorded in the history.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveDate must be in YYYY-MM-DD format',
  })
  effectiveDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    description:
      'Email the confirmation / probation-extension letter with the decision. Defaults to true; send false to skip it.',
  })
  @IsOptional()
  @IsBoolean()
  sendLetter?: boolean;
}

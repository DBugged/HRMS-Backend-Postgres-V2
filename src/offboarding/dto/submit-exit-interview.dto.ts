import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const REASONS_FOR_LEAVING = [
  'Better Opportunity',
  'Compensation',
  'Career Growth',
  'Relocation',
  'Personal Reasons',
  'Work Environment',
  'Health',
  'Other',
] as const;

export class SubmitExitInterviewDto {
  @ApiProperty({ enum: REASONS_FOR_LEAVING })
  @IsIn(REASONS_FOR_LEAVING)
  reasonForLeaving!: (typeof REASONS_FOR_LEAVING)[number];

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  overallExperience!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  wouldRecommend?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  likedMost?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  improvementAreas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  additionalComments?: string;
}

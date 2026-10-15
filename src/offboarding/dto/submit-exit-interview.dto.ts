import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class SubmitExitInterviewDto {
  // One of the org's active "Reason for Leaving" list items (OrgListItem,
  // type REASON_FOR_LEAVING) — checked against that list in
  // OffboardingService.submitExitInterview.
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reasonForLeaving!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  // A form posts the choice as text ("3"); read it as the number it stands for before checking the range.
  @Type(() => Number)
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

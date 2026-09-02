import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

// HR/Admin approving a manager-submitted rating may optionally override the
// submitted rating/payoutPercentage before publishing — same optional-terms
// idiom as ApproveLoanDto.
export class ApprovePerformanceRatingDto {
  @ApiPropertyOptional({ description: '1-5, optional override' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: '0-200, optional override' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  payoutPercentage?: number;
}

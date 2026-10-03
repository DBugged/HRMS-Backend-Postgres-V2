import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SetCompanyPerformanceDto {
  @ApiProperty({ example: '2026-27' })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'financialYear must look like 2026-27.',
  })
  financialYear!: string;

  @ApiPropertyOptional({
    description:
      "Omit / null for the company-wide percentage; a department id for that department's override.",
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  // No business cap (over-achievement can exceed 100% as far as the company
  // wants); the upper bound only rules out typos that would overflow.
  @ApiProperty({ description: 'Percent of target achieved, 0 and up.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000)
  achievementPercent!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

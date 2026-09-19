import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class UpdatePayrollSettingsDto {
  // financialYearStartMonth, currency, and currencySymbol are NOT here —
  // Organization Settings > Policies is their single source of truth
  // (PayrollSettingsService.getOrCreate overlays those onto every read),
  // so this endpoint deliberately can't write them.

  @ApiPropertyOptional({
    description: '0 = last working day of month, 1-31 = fixed day',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31)
  processingDay?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31)
  paymentDay?: number;

  @ApiPropertyOptional({ enum: ['nearest', 'up', 'down', 'none'] })
  @IsOptional()
  @IsIn(['nearest', 'up', 'down', 'none'])
  roundingRule?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  roundingDecimals?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pfEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  esiEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ptEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  lwfEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  npsEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  gratuityEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  bonusEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  incomeTaxEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  employerInsuranceEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pfEmployeeRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pfEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  pfWageCeiling?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  esiEmployeeRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  esiEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  esiWageCeiling?: number;

  @ApiPropertyOptional({ type: [Object], description: '[{upTo, amount}, ...]' })
  @IsOptional()
  @IsArray()
  ptSlabs?: { upTo: number | null; amount: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  lwfEmployeeAmount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  lwfEmployerAmount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  npsEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gratuityRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  compOffExpiryDays?: number;
}

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
  pfEmployeeRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  pfEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  pfWageCeiling?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  esiEmployeeRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  esiEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  esiWageCeiling?: number;

  @ApiPropertyOptional({ type: [Object], description: '[{upTo, amount}, ...]' })
  @IsOptional()
  @IsArray()
  ptSlabs?: { upTo: number | null; amount: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  lwfEmployeeAmount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  lwfEmployerAmount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  npsEmployerRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  gratuityRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  compOffExpiryDays?: number;
}

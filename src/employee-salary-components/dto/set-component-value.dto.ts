import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  Matches,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AmountBasis, CalcType } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class SetComponentValueDto {
  @ApiPropertyOptional({
    description:
      'Resolve the component by id (either this or componentCode is required)',
  })
  @IsOptional()
  @IsUUID()
  componentId?: string;

  @ApiPropertyOptional({
    description: "Resolve the component by code, e.g. 'BASIC'",
  })
  @IsOptional()
  @IsString()
  componentCode?: string;

  @ApiPropertyOptional({
    enum: CalcType,
    description: "Defaults to the component's own calcType if omitted",
  })
  @IsOptional()
  @IsEnum(CalcType)
  valueType?: CalcType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentageValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  percentageOf?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  formula?: string;

  @ApiPropertyOptional({ enum: AmountBasis, default: AmountBasis.MONTHLY })
  @IsOptional()
  @IsEnum(AmountBasis)
  amountBasis?: AmountBasis;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Allow an effectiveFrom inside months whose payroll is already locked/paid. Those payslips stay as they are; the ' +
      'difference is then paid through the Arrears preview/create endpoints.',
  })
  @IsOptional()
  @IsBoolean()
  backdateForArrears?: boolean;

  @ApiPropertyOptional({
    description: 'Defaults to today (server-local date) if omitted',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09',
    description:
      'Pay this component for ONE month only (YYYY-MM) - an arrears, bonus or incentive that must not repeat every ' +
      'month. It starts on the 1st and ends on the last day of that month, so the following month no longer includes ' +
      'it. Refused when the employee already has the component as a running (open-ended) entry.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'applyOnlyForMonth must be a month in YYYY-MM format.',
  })
  applyOnlyForMonth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  revisionNote?: string;
}

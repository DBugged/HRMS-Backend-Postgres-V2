import { ApiPropertyOptional } from '@nestjs/swagger';
import {
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
    description: 'Defaults to today (server-local date) if omitted',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  revisionNote?: string;
}

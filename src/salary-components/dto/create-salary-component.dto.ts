import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  CalcType,
  PayFrequency,
  SalaryComponentType,
  StatutoryKey,
} from '@prisma/client';

export class CreateSalaryComponentDto {
  @ApiProperty({ example: 'House Rent Allowance' })
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description:
      'Auto-derived from name (slugified, uppercased) if omitted. Immutable after creation.',
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ enum: SalaryComponentType })
  @IsEnum(SalaryComponentType)
  type!: SalaryComponentType;

  @ApiPropertyOptional({ enum: CalcType, default: CalcType.FIXED })
  @IsOptional()
  @IsEnum(CalcType)
  calcType?: CalcType;

  @ApiPropertyOptional({
    description: "Another component's code — required when calcType=PERCENTAGE",
  })
  @IsOptional()
  @IsString()
  percentageOf?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentageValue?: number;

  @ApiPropertyOptional({ description: 'Required when calcType=FORMULA' })
  @IsOptional()
  @IsString()
  formula?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  defaultValue?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includeInGross?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includeInNet?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includeInCTC?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isEmployerContribution?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  showOnPayslip?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isStatutory?: boolean;

  @ApiPropertyOptional({ enum: StatutoryKey })
  @IsOptional()
  @IsEnum(StatutoryKey)
  statutoryKey?: StatutoryKey;

  @ApiPropertyOptional({ enum: PayFrequency, default: PayFrequency.MONTHLY })
  @IsOptional()
  @IsEnum(PayFrequency)
  payFrequency?: PayFrequency;
}

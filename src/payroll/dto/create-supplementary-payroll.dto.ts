import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SupplementaryEarningLineDto {
  // A short description shown on the payslip ("Diwali bonus", "Arrears Apr-Jun").
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiProperty({ description: 'Gross amount, > 0.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000000)
  amount!: number;

  // Reuses an existing earning component's identity (BONUS, ARREARS, INCENTIVE ...) so the amount lands in that
  // component's reports. Omitted = a generic SUPPLEMENTARY line.
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{0,39}$/)
  componentCode?: string;

  // Defaults to taxable. Set false for a non-taxable payment (e.g. an exempt reimbursement).
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class CreateSupplementaryPayrollDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty({ minimum: 2000, maximum: 2100 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  // Names the run on the payslip and in the payroll register.
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label!: string;

  // Why this was paid outside the regular run — kept in the audit log.
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ type: [SupplementaryEarningLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SupplementaryEarningLineDto)
  earnings!: SupplementaryEarningLineDto[];
}

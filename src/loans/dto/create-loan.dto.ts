import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { LoanType } from '@prisma/client';

export class CreateLoanDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({ enum: LoanType })
  @IsOptional()
  @IsEnum(LoanType)
  loanType?: LoanType;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  principal!: number;

  @ApiPropertyOptional({ description: 'Annual %' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  interestRate?: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  tenureMonths!: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth!: number;

  @ApiProperty()
  @IsInt()
  startYear!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

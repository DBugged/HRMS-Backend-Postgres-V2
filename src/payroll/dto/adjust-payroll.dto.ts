import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PayrollLineDto {
  @ApiPropertyOptional()
  @IsString()
  code!: string;

  @ApiPropertyOptional()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsNumber()
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class AdjustPayrollDto {
  @ApiPropertyOptional({ type: [PayrollLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayrollLineDto)
  earnings?: PayrollLineDto[];

  @ApiPropertyOptional({ type: [PayrollLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayrollLineDto)
  deductions?: PayrollLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

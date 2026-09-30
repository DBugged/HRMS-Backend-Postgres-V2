import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
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
  @Min(0)
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

  // Manual correction to this one run's LOP day count — calculate() derives
  // it from attendance/leave records, but a real-world exception (a missed
  // regularization, a verbal approval never logged, an approved LOP the
  // employee's own department forgot to convert to an actual leave record)
  // sometimes needs HR to just override the number directly, same as they
  // already can for any earnings/deductions line above. payableDays is
  // recomputed to stay consistent (see adjust() in payroll.service.ts) —
  // everything else on attendanceSummary (present/absent/leave counts,
  // overtime, etc.) is left exactly as calculate() derived it.
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  lopDaysOverride?: number;
}

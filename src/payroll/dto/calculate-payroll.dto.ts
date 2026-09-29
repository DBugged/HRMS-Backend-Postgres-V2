import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CalculatePayrollDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  // Ignored when employeeId is set (that's already a single explicit
  // target). Only applies to the bulk "run for everyone" path — lets HR
  // skip specific employees for this one run without giving them the
  // standing User.excludeFromPayroll flag.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsUUID('4', { each: true })
  excludeEmployeeIds?: string[];
}

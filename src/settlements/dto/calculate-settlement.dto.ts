import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Matches, Min } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CalculateSettlementDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'lastWorkingDay must be in YYYY-MM-DD format' })
  lastWorkingDay!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonusAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  recoveriesAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  noticePeriodRecovery?: number;
}

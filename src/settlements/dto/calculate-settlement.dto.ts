import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class CalculateSettlementDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
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

  @ApiPropertyOptional({
    description:
      'Exit is due to death or disablement - gratuity is then payable without the five-year minimum service (s.4(1) proviso).',
  })
  @IsOptional()
  @IsBoolean()
  deathOrDisablement?: boolean;
}

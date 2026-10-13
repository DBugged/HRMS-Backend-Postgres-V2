import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
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

  @ApiPropertyOptional({
    description:
      'Notice-period recovery. Leave it out to have it worked out from the notice days (resignation: days short of the notice x the daily rate). An amount - 0 to waive it - overrides.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  noticePeriodRecovery?: number;

  @ApiPropertyOptional({
    description:
      'When the company ends the employment before the notice period is over: pay the shortfall days as notice pay.',
  })
  @IsOptional()
  @IsBoolean()
  payNoticeInLieu?: boolean;

  @ApiPropertyOptional({
    description:
      'What the recoveries are for. Required when recoveriesAmount > 0.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recoveriesReason?: string;

  @ApiPropertyOptional({
    description:
      'If the loan balance is more than what is payable, recover only what is payable and leave the rest as an open loan, instead of refusing the settlement.',
  })
  @IsOptional()
  @IsBoolean()
  allowPartialLoanRecovery?: boolean;

  @ApiPropertyOptional({
    description:
      'Exit is due to death or disablement - gratuity is then payable without the five-year minimum service (s.4(1) proviso).',
  })
  @IsOptional()
  @IsBoolean()
  deathOrDisablement?: boolean;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// The most any one entered amount (bonus, recoveries, notice recovery) may be - the same Rs 1 crore the form allows.
export const MAX_SETTLEMENT_AMOUNT = 10_000_000;

export class CalculateSettlementDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
  lastWorkingDay!: string;

  @ApiPropertyOptional({
    description:
      'Bonus to pay. Leave it out to have the statutory bonus due for the accounting year (less what was already paid) calculated; an amount - 0 to pay none - overrides it.',
  })
  @IsOptional()
  // Rupees and paise: at most two decimals.
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Bonus must be an amount with at most 2 decimals.' },
  )
  @Min(0, { message: 'Bonus cannot be negative.' })
  @Max(MAX_SETTLEMENT_AMOUNT, {
    message: 'Bonus cannot be more than Rs 1,00,00,000.',
  })
  bonusAmount?: number;

  @ApiPropertyOptional({
    description:
      'The employee is disqualified from statutory bonus (dismissal for fraud, violence or misconduct causing financial loss): none is calculated.',
  })
  @IsOptional()
  @IsBoolean()
  bonusDisqualified?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  // Rupees and paise: at most two decimals.
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Recoveries must be an amount with at most 2 decimals.' },
  )
  @Min(0, { message: 'Recoveries cannot be negative.' })
  @Max(MAX_SETTLEMENT_AMOUNT, {
    message: 'Recoveries cannot be more than Rs 1,00,00,000.',
  })
  recoveriesAmount?: number;

  @ApiPropertyOptional({
    description:
      'Notice-period recovery. Leave it out to have it worked out from the notice days (resignation: days short of the notice x the daily rate). An amount - 0 to waive it - overrides.',
  })
  @IsOptional()
  // Rupees and paise: at most two decimals.
  @IsNumber(
    { maxDecimalPlaces: 2 },
    {
      message:
        'Notice period recovery must be an amount with at most 2 decimals.',
    },
  )
  @Min(0, { message: 'Notice period recovery cannot be negative.' })
  @Max(MAX_SETTLEMENT_AMOUNT, {
    message: 'Notice period recovery cannot be more than Rs 1,00,00,000.',
  })
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

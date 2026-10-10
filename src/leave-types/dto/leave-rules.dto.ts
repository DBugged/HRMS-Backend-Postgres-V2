import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

// Mirrors the old system's LeaveType.rules JSON shape exactly — read
// generically by the future Leave-requests module's rule-checking logic,
// never branched on per-leave-type name.
export class LeaveRulesDto {
  @ApiPropertyOptional({ default: 0.5 })
  @IsOptional()
  @IsNumber()
  minDurationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxDurationDays?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  noticePeriodDays?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowBackdated?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  maxBackdateDays?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowFutureDated?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  maxAdvanceDays?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowHalfDay?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  sandwichLeaveApplies?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  restrictPrefixSuffixHoliday?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  maxConsecutiveDays?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  minGapBetweenRequestsDays?: number;
}

export class CarryForwardDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  maxDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  expiryMonths?: number | null;
}

export class NegativeBalanceDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  maxNegativeDays?: number;
}

export class EncashmentRulesDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  maxDaysPerYear?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  minBalanceToRetain?: number;
}

// Settings of an EVENT_BASED leave type (see LeaveType.eventGrant). The maximum days per event is the type's annualQuota.
export class EventGrantDto {
  @ApiPropertyOptional({ enum: ['CALENDAR_DAYS', 'WORKING_DAYS'] })
  @IsOptional()
  @IsIn(['CALENDAR_DAYS', 'WORKING_DAYS'])
  unit?: 'CALENDAR_DAYS' | 'WORKING_DAYS';

  @ApiPropertyOptional({ enum: ['ONCE_PER_EVENT', 'MIN_INTERVAL'] })
  @IsOptional()
  @IsIn(['ONCE_PER_EVENT', 'MIN_INTERVAL'])
  repeatPolicy?: 'ONCE_PER_EVENT' | 'MIN_INTERVAL';

  @ApiPropertyOptional({
    description:
      'Months that must pass between two events (repeatPolicy MIN_INTERVAL).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  minIntervalMonths?: number;

  @ApiPropertyOptional({
    description:
      'Days that must pass between two events (repeatPolicy MIN_INTERVAL).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36500)
  minIntervalDays?: number;

  @ApiPropertyOptional({
    description: 'YYYY-MM-DD; no grant can take effect before this date.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string | null;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AllocationType,
  AccrualBasis,
  AccrualFrequency,
  AccrualTiming,
  Gender,
  LeaveAccrualMode,
} from '@prisma/client';
import {
  CarryForwardDto,
  EncashmentRulesDto,
  EventGrantDto,
  LeaveRulesDto,
  NegativeBalanceDto,
} from './leave-rules.dto';

export class CreateLeaveTypeDto {
  @ApiProperty({ example: 'Earned Leave' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'EL' })
  @IsNotEmpty()
  @IsString()
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: '#3b82f6' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({
    enum: AllocationType,
    default: AllocationType.FIXED_ANNUAL,
  })
  @IsOptional()
  @IsEnum(AllocationType)
  allocationType?: AllocationType;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  annualQuota?: number;

  @ApiPropertyOptional({
    enum: LeaveAccrualMode,
    default: 'UPFRONT',
    description:
      'UPFRONT credits the whole yearly quota at the start of the leave year; PERIODIC credits it in instalments (see accrualFrequency).',
  })
  @IsOptional()
  @IsEnum(LeaveAccrualMode)
  accrualMode?: LeaveAccrualMode;

  @ApiPropertyOptional({
    enum: AccrualBasis,
    default: 'LEAVE_YEAR',
    description:
      "PERIODIC only: LEAVE_YEAR credits on the same dates for everyone; JOINING_ANNIVERSARY runs each employee's cycles from their own joining date.",
  })
  @IsOptional()
  @IsEnum(AccrualBasis)
  accrualBasis?: AccrualBasis;

  @ApiPropertyOptional({
    enum: AccrualFrequency,
    description: 'PERIODIC only: how often a credit is made.',
  })
  @IsOptional()
  @IsEnum(AccrualFrequency)
  accrualFrequency?: AccrualFrequency;

  @ApiPropertyOptional({
    description:
      'PERIODIC only: days per cycle. Leave empty to spread the yearly quota evenly.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accrualAmountPerCycle?: number;

  @ApiPropertyOptional({
    enum: AccrualTiming,
    default: 'END',
    description:
      'PERIODIC only: START credits at the beginning of each period, END once it has been worked.',
  })
  @IsOptional()
  @IsEnum(AccrualTiming)
  accrueAt?: AccrualTiming;

  @ApiPropertyOptional({
    description:
      'PERIODIC only: balance ceiling - a credit stops once the balance reaches it.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBalance?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  prorateOnJoining?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: '[] = applies to all departments',
  })
  @IsOptional()
  @IsArray()
  applicableDepartments?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: '[] = applies to all employee types',
  })
  @IsOptional()
  @IsArray()
  applicableEmployeeTypes?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      '[] = applies to all genders; values are Gender enum names (MALE/FEMALE/OTHER)',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(Gender, { each: true })
  applicableGenders?: string[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minServiceMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxServiceMonths?: number | null;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsNumber()
  salaryImpactPercent?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  affectsLopCalculation?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  showInLeaveTracker?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  approvalLevels?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  autoApproveIfNoAction?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  autoApproveHours?: number;

  @ApiPropertyOptional({ type: LeaveRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveRulesDto)
  rules?: LeaveRulesDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  documentsRequired?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether this balance counts toward the profile/dashboard total leave balance.',
  })
  @IsOptional()
  @IsBoolean()
  countInTotalBalance?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  documentRequiredAfterDays?: number | null;

  @ApiPropertyOptional({ type: CarryForwardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CarryForwardDto)
  carryForward?: CarryForwardDto;

  @ApiPropertyOptional({ type: NegativeBalanceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NegativeBalanceDto)
  negativeBalance?: NegativeBalanceDto;

  @ApiPropertyOptional({ type: EncashmentRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EncashmentRulesDto)
  encashment?: EncashmentRulesDto;

  @ApiPropertyOptional({ type: EventGrantDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventGrantDto)
  eventGrant?: EventGrantDto;
}

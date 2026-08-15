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
  ValidateNested,
} from 'class-validator';
import { AllocationType, AccrualFrequency } from '@prisma/client';
import {
  CarryForwardDto,
  EncashmentRulesDto,
  LeaveRulesDto,
  NegativeBalanceDto,
} from './leave-rules.dto';

export class CreateLeaveTypeDto {
  @ApiProperty({ example: 'Earned Leave' })
  @IsNotEmpty()
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
    enum: AccrualFrequency,
    default: AccrualFrequency.YEARLY,
  })
  @IsOptional()
  @IsEnum(AccrualFrequency)
  accrualFrequency?: AccrualFrequency;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  accrualAmountPerCycle?: number;

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
  applicableGenders?: string[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  minServiceMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
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
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: 2 })
  @IsOptional()
  @IsInt()
  approvalLevels?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  autoApproveIfNoAction?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  autoApproveDays?: number;

  @ApiPropertyOptional({ type: LeaveRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveRulesDto)
  rules?: LeaveRulesDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  documentsRequired?: boolean;

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
}

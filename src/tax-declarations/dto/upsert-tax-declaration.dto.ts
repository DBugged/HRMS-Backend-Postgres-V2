import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { TaxDeclarationStatus, TaxRegime } from '@prisma/client';

// Mirrors the exact caps tax-engine.ts already applies at payroll-compute
// time (see calculateTax's Math.min() calls) — previously a declaration
// could claim far more than the statutory limit with no feedback at all;
// the excess was silently capped away only once payroll ran, weeks later,
// with no indication to the employee why their declared amount didn't
// match their actual deduction. 80E (education-loan interest) and 80G
// (donations) are deliberately left unbounded here too, matching the
// engine — neither has a simple fixed statutory ceiling the way 80C/
// 80CCD(1B)/80D do.
const SECTION_80C_CAP = 150000;
const SECTION_80CCD1B_CAP = 50000;
const SECTION_80D_CAP = 100000;

export class UpsertTaxDeclarationDto {
  @ApiPropertyOptional({
    description: 'Ignored (forced to self) for EMPLOYEE callers',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: '2026-27' })
  @IsNotEmpty()
  financialYear!: string;

  @ApiPropertyOptional({ enum: TaxRegime, default: TaxRegime.NEW })
  @IsOptional()
  @IsEnum(TaxRegime)
  regimeChosen?: TaxRegime;

  @ApiPropertyOptional({ maximum: SECTION_80C_CAP })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(SECTION_80C_CAP)
  section80C?: number;
  @ApiPropertyOptional({ maximum: SECTION_80CCD1B_CAP })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(SECTION_80CCD1B_CAP)
  section80CCD1B?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  section80CCD2?: number;
  @ApiPropertyOptional({ maximum: SECTION_80D_CAP })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(SECTION_80D_CAP)
  section80D?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) section80E?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) section80G?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() otherDeductions?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() hraRentPaidAnnual?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isMetroCity?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() ltaClaimed?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  previousEmployerIncome?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() previousEmployerTDS?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() otherIncome?: number;

  @ApiPropertyOptional({
    enum: TaxDeclarationStatus,
    description:
      'Silently stripped when the caller is editing their own declaration',
  })
  @IsOptional()
  @IsEnum(TaxDeclarationStatus)
  status?: TaxDeclarationStatus;

  // Own-declaration-only: the one status transition an employee can make
  // themselves (DRAFT -> SUBMITTED), locking their own declaration against
  // further self-edits. Distinct from `status` (which they can never set
  // directly) so a plain field-save call can never accidentally submit.
  @ApiPropertyOptional({
    description:
      "Employee's own submit action — locks the declaration (DRAFT -> SUBMITTED). Ignored for non-own declarations.",
  })
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}

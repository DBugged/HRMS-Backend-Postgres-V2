import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { TaxDeclarationStatus, TaxRegime } from '@prisma/client';

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

  @ApiPropertyOptional() @IsOptional() @IsNumber() section80C?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() section80CCD1B?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() section80CCD2?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() section80D?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() section80E?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() section80G?: number;
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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export const PAYMENT_MODES = [
  'NEFT',
  'RTGS',
  'IMPS',
  'UPI',
  'CHEQUE',
  'CASH',
  'OTHER',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export class RecordPaymentDto {
  @ApiPropertyOptional({ enum: PAYMENT_MODES })
  @IsOptional()
  @IsIn(PAYMENT_MODES)
  paymentMode?: PaymentMode;

  // Bank UTR / transaction or cheque number. A batch payment may carry the same reference on many payslips.
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9/_.-]+$/, {
    message: 'paymentReference may contain letters, digits and / _ . - only',
  })
  paymentReference!: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, defaults to today' })
  @IsOptional()
  @IsValidCalendarDateString()
  paymentDate?: string;
}

export class PaymentImportRowDto extends RecordPaymentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  payslipNumber!: string;

  // When given, must equal the payslip's net pay - catches a file paid against the wrong run.
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  amount?: number;
}

export class ImportPaymentsDto {
  @ApiProperty({ type: [PaymentImportRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PaymentImportRowDto)
  rows!: PaymentImportRowDto[];
}

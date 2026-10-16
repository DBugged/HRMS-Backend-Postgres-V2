import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Amounts in rupees for the months of the financial year before payroll started here.
export class OpeningBalanceDto {
  @IsInt()
  @Min(0)
  @Max(11)
  monthsCovered!: number;

  @IsNumber()
  @Min(0)
  taxableEarnings!: number;

  @IsNumber()
  @Min(0)
  tdsDeducted!: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  pfPaid?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  ptPaid?: number;
}

export class OpeningBalanceImportRowDto extends OpeningBalanceDto {
  @IsString()
  employeeCode!: string;
}

export class OpeningBalanceImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningBalanceImportRowDto)
  rows!: OpeningBalanceImportRowDto[];
}

export class OpeningBalanceQueryDto {
  // The first payroll month; sets the financial year and how many months can precede it. Defaults to this month.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  year?: number;
}

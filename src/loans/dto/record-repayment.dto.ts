import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class RecordRepaymentDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty()
  @IsInt()
  year!: number;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  payrollRun?: string;
}

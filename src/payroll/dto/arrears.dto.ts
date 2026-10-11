import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ArrearsPreviewDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  // First and last LOCKED/PAID month to re-price with the employee's current (backdated) salary structure.
  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  fromMonth!: number;

  @ApiProperty({ minimum: 2000, maximum: 2100 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  fromYear!: number;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  toMonth!: number;

  @ApiProperty({ minimum: 2000, maximum: 2100 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  toYear!: number;
}

export class CreateArrearsDto extends ArrearsPreviewDto {
  // The month the arrears are paid in (default: the current month in the organisation's timezone).
  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  payMonth?: number;

  @ApiPropertyOptional({ minimum: 2000, maximum: 2100 })
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  payYear?: number;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label?: string;
}

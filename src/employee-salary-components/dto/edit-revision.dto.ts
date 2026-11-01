// Purpose: Request body for correcting one salary revision (all component rows sharing an effective date) in place.
// Important: every field except `effectiveFrom` (the revision being edited) is optional; omitted fields stay as they are.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AmountBasis } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class EditRevisionLineDto {
  @ApiProperty({ description: "Component code, e.g. 'BASIC'" })
  @IsString()
  componentCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentageValue?: number;

  @ApiPropertyOptional({ enum: AmountBasis })
  @IsOptional()
  @IsEnum(AmountBasis)
  amountBasis?: AmountBasis;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class EditRevisionDto {
  @ApiProperty({ description: 'Effective date (YYYY-MM-DD) of the revision being edited' })
  @IsValidCalendarDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'Move the revision to this date' })
  @IsOptional()
  @IsValidCalendarDateString()
  newEffectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  revisionNote?: string;

  @ApiPropertyOptional({ type: [EditRevisionLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditRevisionLineDto)
  lines?: EditRevisionLineDto[];
}

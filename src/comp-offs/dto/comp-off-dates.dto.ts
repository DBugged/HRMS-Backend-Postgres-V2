import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export const MAX_COMP_OFF_DATES = 31;

// Dates arrive as a comma list in a query string ("2026-11-01,2026-11-02") or as an array in a body.
const toDateList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value.split(',').map((d) => d.trim()).filter(Boolean)
    : value;

export class PreviewCompOffDto {
  @ApiProperty({ example: '2026-11-01,2026-11-02' })
  @Transform(toDateList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COMP_OFF_DATES)
  @IsValidCalendarDateString({ each: true })
  dates!: string[];

  @ApiPropertyOptional({ description: 'Only honored for ADMIN/HR/MANAGER.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CreateCompOffsDto {
  @ApiProperty({ example: ['2026-11-01', '2026-11-02'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COMP_OFF_DATES)
  @IsValidCalendarDateString({ each: true })
  dates!: string[];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'Reason is required' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Only honored for ADMIN/HR/MANAGER.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

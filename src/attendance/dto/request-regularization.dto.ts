import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class RequestRegularizationDto {
  @ApiProperty({ description: 'YYYY-MM-DD, must not be in the future' })
  @IsValidCalendarDateString()
  date!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  requestedInTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  requestedOutTime?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  reason!: string;
}

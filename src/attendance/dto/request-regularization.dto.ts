import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RequestRegularizationDto {
  @ApiProperty({ description: 'YYYY-MM-DD, must not be in the future' })
  @Matches(DATE_RE, { message: 'date must be in YYYY-MM-DD format' })
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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateCompOffDto {
  @ApiProperty({ example: '2026-01-25' })
  @Matches(DATE_RE, { message: 'earnedForDate must be in YYYY-MM-DD format' })
  earnedForDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  daysEarned?: number;

  @ApiPropertyOptional({
    description:
      'Only honored if the caller is ADMIN/HR/MANAGER — earns on behalf of another employee.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

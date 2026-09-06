import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class CreateCompOffDto {
  @ApiProperty({ example: '2026-01-25' })
  @IsValidCalendarDateString()
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

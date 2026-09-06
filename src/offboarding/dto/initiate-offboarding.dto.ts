import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class InitiateOffboardingDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-06-30' })
  @IsValidCalendarDateString()
  lastWorkingDay!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

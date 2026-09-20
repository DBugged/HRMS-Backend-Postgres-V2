import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { EmploymentStatus } from '@prisma/client';
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

  // The employmentStatus complete() applies when the exit finishes. Defaults to RELEASED.
  @ApiPropertyOptional({
    enum: ['RESIGNED', 'RELEASED', 'TERMINATED', 'ABSCONDED'],
  })
  @IsOptional()
  @IsIn(['RESIGNED', 'RELEASED', 'TERMINATED', 'ABSCONDED'])
  exitStatus?: EmploymentStatus;
}

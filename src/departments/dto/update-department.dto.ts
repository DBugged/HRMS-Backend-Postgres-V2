import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class UpdateDepartmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shiftStartTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shiftEndTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  lateInThresholdMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  earlyOutThresholdMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  minHoursForPresent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  minHoursForHalfDay?: number;

  @ApiPropertyOptional({
    type: [Number],
    description: '0=Sunday ... 6=Saturday',
  })
  @IsOptional()
  @IsArray()
  weeklyOffs?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'null clears the assigned geo-fence' })
  @IsOptional()
  @IsUUID()
  workLocationId?: string | null;

  @ApiPropertyOptional({
    description:
      "null unassigns the work schedule (keeps whatever shift fields the department already has); a valid id copies that schedule's hours/working-days/off-pattern/break minutes onto this department, same as assigning from the Work Schedules page.",
  })
  @IsOptional()
  @IsUUID()
  workScheduleId?: string | null;
}

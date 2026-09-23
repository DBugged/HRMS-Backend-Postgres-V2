import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name!: string;

  // Uppercased in DepartmentsService.create() — Prisma has no model-level
  // hooks (unlike the old Sequelize model's beforeValidate).
  @ApiProperty({ example: 'ENG' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: '09:30' })
  @IsOptional()
  @IsString()
  shiftStartTime?: string;

  @ApiPropertyOptional({ example: '18:30' })
  @IsOptional()
  @IsString()
  shiftEndTime?: string;

  @ApiPropertyOptional({
    type: [Number],
    description: '0=Sunday ... 6=Saturday',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weeklyOffs?: number[];

  @ApiPropertyOptional({
    default: false,
    description:
      'True for a shift that starts on one calendar day and ends on the next (e.g. 22:00-06:00).',
  })
  @IsOptional()
  @IsBoolean()
  crossesMidnight?: boolean;

  // When set, the schedule's startTime/endTime/workingDays/breakMinutes
  // are copied onto this department at creation — the same copy DepartmentsService
  // does for an existing department when a Work Schedule is assigned to it — and
  // shiftStartTime/shiftEndTime/weeklyOffs above are ignored. Optional because a
  // department can still be created before any schedule exists.
  @ApiPropertyOptional({
    description:
      "A Work Schedule to copy this department's shift hours/weekly offs/break time from.",
  })
  @IsOptional()
  @IsString()
  workScheduleId?: string;
}

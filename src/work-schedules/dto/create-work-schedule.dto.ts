import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// One "alternate" day — off only on the given occurrence(s) of the month
// (1st..5th) rather than every week. E.g. { day: 6, occurrences: [2, 4] }
// = 2nd/4th Saturday off, 1st/3rd/5th worked.
export class AlternateWeeklyOffDto {
  @ApiProperty({ description: '0=Sunday ... 6=Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  day!: number;

  @ApiProperty({
    type: [Number],
    description: '1st..5th occurrence of that weekday in the month',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  occurrences!: number[];
}

export class CreateWorkScheduleDto {
  @ApiProperty({ example: 'General Shift' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ type: [Number], description: '0=Sunday ... 6=Saturday' })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workingDays!: number[];

  @ApiProperty({ example: '09:30' })
  @IsString()
  startTime!: string;

  @ApiProperty({ example: '18:30' })
  @IsString()
  endTime!: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  // Only for days NOT in workingDays — a day off every week by default
  // doesn't need an entry here; only list a day if it should be off on
  // just some occurrences (see WorkSchedulesService's overlap validation).
  @ApiPropertyOptional({ type: [AlternateWeeklyOffDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlternateWeeklyOffDto)
  alternateWeeklyOffs?: AlternateWeeklyOffDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

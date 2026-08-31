import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
} from 'class-validator';

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

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

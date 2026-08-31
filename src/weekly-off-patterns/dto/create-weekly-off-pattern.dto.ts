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

export class CreateWeeklyOffPatternDto {
  @ApiProperty({ example: 'Standard (Sun only)' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ type: [Number], description: '0=Sunday ... 6=Saturday' })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOff!: number[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

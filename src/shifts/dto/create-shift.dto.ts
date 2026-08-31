import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateShiftDto {
  @ApiProperty({ example: 'Morning Shift' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: '09:30' })
  @IsString()
  startTime!: string;

  @ApiProperty({ example: '18:30' })
  @IsString()
  endTime!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

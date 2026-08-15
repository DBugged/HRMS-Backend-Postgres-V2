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
}

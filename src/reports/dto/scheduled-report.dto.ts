import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

const FORMATS = ['xlsx', 'csv', 'pdf'];
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];

export class CreateScheduledReportDto {
  @ApiProperty()
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ description: 'A key from GET /reports/scheduled/options' })
  @IsString()
  @Length(2, 60)
  reportKey!: string;

  @ApiPropertyOptional({ enum: FORMATS, default: 'xlsx' })
  @IsOptional()
  @IsIn(FORMATS)
  format?: string;

  @ApiProperty({ enum: FREQUENCIES })
  @IsIn(FREQUENCIES)
  frequency!: string;

  @ApiPropertyOptional({ description: 'Weekly: 0 (Sunday) to 6' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({ description: 'Monthly: 1 to 28' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth?: number;

  @ApiPropertyOptional({
    description: 'Hour of the day (0-23) in the organization timezone',
    default: 8,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  sendHour?: number;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  recipients!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateScheduledReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 60)
  reportKey?: string;

  @ApiPropertyOptional({ enum: FORMATS })
  @IsOptional()
  @IsIn(FORMATS)
  format?: string;

  @ApiPropertyOptional({ enum: FREQUENCIES })
  @IsOptional()
  @IsIn(FREQUENCIES)
  frequency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  sendHour?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  recipients?: string[];

  @ApiPropertyOptional({ description: 'null clears the department filter' })
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

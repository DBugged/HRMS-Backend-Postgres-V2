import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

// One day's In/Out, the same for every employee in the request.
export class BulkManualPunchTimesDto {
  @ApiProperty({ description: 'ISO 8601 check-in (or the only punch of the day)' })
  @IsNotEmpty()
  @IsISO8601()
  punchTime!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 check-out, after punchTime and in the same shift day' })
  @IsOptional()
  @IsNotEmpty()
  @IsISO8601()
  outPunchTime?: string;
}

export class BulkManualPunchDto {
  @ApiProperty({ type: [String], description: 'Employee UUIDs (User.id)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  employeeIds!: string[];

  @ApiProperty({ type: [BulkManualPunchTimesDto], description: 'One entry per day' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => BulkManualPunchTimesDto)
  punches!: BulkManualPunchTimesDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;
}

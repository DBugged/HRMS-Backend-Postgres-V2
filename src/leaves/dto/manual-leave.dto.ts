import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// An Admin / HR recording an approved leave on behalf of one or more employees (the leave equivalent of a manual punch).
export class ManualLeaveDto {
  @ApiProperty({ type: [String], description: 'Employee UUIDs (User.id)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  employeeIds!: string[];

  @ApiProperty({ description: 'Leave type id' })
  @IsUUID()
  leaveTypeId!: string;

  @ApiProperty({ example: '2026-11-03' })
  @IsValidCalendarDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-11-05' })
  @IsValidCalendarDateString()
  endDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isHalfDay?: boolean;

  @ApiPropertyOptional({ enum: ['FIRST_HALF', 'SECOND_HALF'] })
  @IsOptional()
  @IsIn(['FIRST_HALF', 'SECOND_HALF'])
  halfDaySession?: 'FIRST_HALF' | 'SECOND_HALF';

  @ApiPropertyOptional({ description: 'Why it was recorded, e.g. "Informed by phone"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { HalfDaySession } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class ApplyLeaveDto {
  @ApiProperty()
  @IsUUID()
  leaveType!: string;

  @ApiProperty({ example: '2026-06-10' })
  @IsValidCalendarDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-06-12' })
  @IsValidCalendarDateString()
  endDate!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isHalfDay?: boolean;

  @ApiPropertyOptional({ enum: HalfDaySession })
  @IsOptional()
  @IsEnum(HalfDaySession)
  halfDaySession?: HalfDaySession;

  @ApiProperty({ description: 'Reason for the leave (required).' })
  @IsString()
  @IsNotEmpty({ message: 'Remarks are required' })
  @Matches(/\S/, { message: 'Remarks are required' })
  remarks!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  attachmentUrl?: string;
}

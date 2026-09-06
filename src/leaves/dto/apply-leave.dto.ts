import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  attachmentUrl?: string;
}

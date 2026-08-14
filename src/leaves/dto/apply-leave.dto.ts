import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { HalfDaySession } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ApplyLeaveDto {
  @ApiProperty()
  @IsUUID()
  leaveType!: string;

  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'startDate must be in YYYY-MM-DD format' })
  startDate!: string;

  @ApiProperty({ example: '2026-06-12' })
  @Matches(DATE_RE, { message: 'endDate must be in YYYY-MM-DD format' })
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

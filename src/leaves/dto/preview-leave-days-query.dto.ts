import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

// Query of GET /leaves/preview-days: the same three inputs that decide how many days a leave costs.
export class PreviewLeaveDaysQueryDto {
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
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  isHalfDay?: boolean;
}

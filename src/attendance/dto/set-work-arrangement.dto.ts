import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { WorkArrangement } from '@prisma/client';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class SetWorkArrangementDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, defaults to today' })
  @IsOptional()
  @IsValidCalendarDateString()
  date?: string;

  @ApiProperty({ enum: WorkArrangement })
  @IsEnum(WorkArrangement)
  workArrangement!: WorkArrangement;

  @ApiPropertyOptional({
    description:
      'Last day of a multi-day Work From Home request (YYYY-MM-DD), with `date` as the first. Only the working days in the range are requested - weekly offs, holidays and leave days are left out - and they are reviewed together as one request. Up to 31 calendar days.',
  })
  @IsOptional()
  @IsValidCalendarDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      "The employee's reason for a Work From Home request, shown to the approver. Up to 500 characters after trimming; empty counts as no reason. On a multi-day request every day gets the same reason. Ignored for any other arrangement.",
    maxLength: 500,
    type: String,
    nullable: true,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsOptional()
  // Listed in this order on purpose: the rule nearest the property runs first, and the app-wide pipe shows only the
  // first rule broken, so a value that is not text is told that rather than that it is too long.
  @MaxLength(500, { message: 'Reason must be at most 500 characters.' })
  @IsString()
  reason?: string | null;
}

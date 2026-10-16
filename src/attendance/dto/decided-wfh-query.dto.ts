// Purpose: Query for the decided (approved / rejected) Work From Home requests list.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class DecidedWfhQueryDto {
  @ApiPropertyOptional({ enum: ['approved', 'rejected', 'decided'], description: 'decided = approved and rejected' })
  @IsOptional()
  @IsIn(['approved', 'rejected', 'decided'])
  status?: 'approved' | 'rejected' | 'decided';

  @ApiPropertyOptional({ description: 'Earliest attendance date, YYYY-MM-DD' })
  @IsOptional()
  @IsValidCalendarDateString()
  from?: string;
}

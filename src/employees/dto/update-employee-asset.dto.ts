import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class UpdateEmployeeAssetDto {
  @ApiProperty({ enum: ['ALLOCATED', 'RETURNED', 'LOST'] })
  @IsIn(['ALLOCATED', 'RETURNED', 'LOST'])
  status!: 'ALLOCATED' | 'RETURNED' | 'LOST';

  @ApiPropertyOptional({ description: 'Required when status=RETURNED' })
  @IsOptional()
  @IsValidCalendarDateString()
  returnedDate?: string;
}

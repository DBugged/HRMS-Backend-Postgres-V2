import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateEmployeeAssetDto {
  @ApiProperty({ enum: ['ALLOCATED', 'RETURNED', 'LOST'] })
  @IsIn(['ALLOCATED', 'RETURNED', 'LOST'])
  status!: 'ALLOCATED' | 'RETURNED' | 'LOST';

  @ApiPropertyOptional({ description: 'Required when status=RETURNED' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'returnedDate must be in YYYY-MM-DD format' })
  returnedDate?: string;
}

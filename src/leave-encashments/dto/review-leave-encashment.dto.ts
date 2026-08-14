import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ReviewLeaveEncashmentDto {
  @ApiProperty({ enum: ['APPROVED', 'PROCESSED'] })
  @IsIn(['APPROVED', 'PROCESSED'])
  status!: 'APPROVED' | 'PROCESSED';
}

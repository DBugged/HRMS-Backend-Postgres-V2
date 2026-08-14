import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ReviewCompOffDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';
}

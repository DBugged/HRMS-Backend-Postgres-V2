import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewLeaveEncashmentDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED', 'PROCESSED'] })
  @IsIn(['APPROVED', 'REJECTED', 'PROCESSED'])
  status!: 'APPROVED' | 'REJECTED' | 'PROCESSED';

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Required when rejecting; shown to the employee.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comments?: string;
}

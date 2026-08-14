import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ReviewLeaveDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED', 'RETURNED'] })
  @IsIn(['APPROVED', 'REJECTED', 'RETURNED'])
  decision!: 'APPROVED' | 'REJECTED' | 'RETURNED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comments?: string;
}

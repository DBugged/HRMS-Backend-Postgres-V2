import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewOvertimeDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({
    description:
      'Weekend/holiday work only: how it is compensated (a key from GET /overtime/compensation-options). Omitted = the organisation default, or the hourly rate when none is set.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  compensationKey?: string;
}

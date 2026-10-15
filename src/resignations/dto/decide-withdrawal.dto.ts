import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class DecideWithdrawalDto {
  @ApiProperty({ enum: ['APPROVE', 'DECLINE'] })
  @IsIn(['APPROVE', 'DECLINE'])
  decision!: 'APPROVE' | 'DECLINE';

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Required when declining (the employee is told why); optional when approving.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

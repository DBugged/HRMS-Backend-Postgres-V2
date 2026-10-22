import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// The employee's request to cancel an approved leave that has already started.
export class RequestLeaveCancelDto {
  @ApiProperty({ description: 'Why the leave should be cancelled' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

// A manager / HR / Admin deciding that request.
export class DecideLeaveCancelDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Required when declining' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comments?: string;
}

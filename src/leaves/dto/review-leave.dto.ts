import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class ReviewLeaveDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED', 'RETURNED'] })
  @IsIn(['APPROVED', 'REJECTED', 'RETURNED'])
  decision!: 'APPROVED' | 'REJECTED' | 'RETURNED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comments?: string;

  // HR / Admin only: approve without waiting for the manager's level-1 sign-off (the manager is away or inactive).
  // A comment saying why is required, and the override is recorded in the audit trail.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  overrideLevelOne?: boolean;
}

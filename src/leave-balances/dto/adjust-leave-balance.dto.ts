import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class AdjustLeaveBalanceDto {
  @ApiProperty({ description: 'Employee UUID (User.id)' })
  @IsUUID()
  employeeId!: string;

  @ApiProperty()
  @IsUUID()
  leaveTypeId!: string;

  @ApiPropertyOptional({
    description: 'Leave year key (defaults to the current leave year)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiProperty({
    description:
      'Days to add (positive) or take off (negative); at most 365 either way',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-365)
  @Max(365)
  days!: number;

  @ApiProperty({
    description: 'Why the balance is being changed (kept in the audit trail)',
  })
  @IsString()
  @MinLength(5)
  reason!: string;
}

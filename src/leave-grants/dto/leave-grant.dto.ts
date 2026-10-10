import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateLeaveGrantDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty()
  @IsUUID()
  leaveTypeId!: string;

  @ApiProperty({
    example: '2026-10-01',
    description: 'The qualifying event (childbirth, adoption...).',
  })
  @Matches(ISO_DATE)
  eventDate!: string;

  @ApiPropertyOptional({
    description: 'When the leave starts counting; defaults to the event date.',
  })
  @IsOptional()
  @Matches(ISO_DATE)
  effectiveDate?: string;

  @ApiProperty({
    description:
      'Approved entitlement for this event (not above the leave type maximum).',
  })
  @IsNumber()
  @Min(0.5)
  days!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Reference of the supporting document / eligibility confirmation.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  documentRef?: string;

  @ApiPropertyOptional({
    description: 'Makes a retried request return the original grant.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

export class ReverseLeaveGrantDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class QueryLeaveGrantsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  leaveTypeId?: string;
}

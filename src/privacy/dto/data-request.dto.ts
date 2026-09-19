import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataRequestStatus, DataRequestType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDataRequestDto {
  @ApiProperty({ enum: DataRequestType })
  @IsEnum(DataRequestType)
  type!: DataRequestType;

  @ApiPropertyOptional({
    description:
      'CORRECTION/UPDATE only: proposed values keyed by field, e.g. { "phone": "...", "currentAddress": "..." }',
  })
  @IsOptional()
  @IsObject()
  fields?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Free-text explanation' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class ListDataRequestsQueryDto {
  @ApiPropertyOptional({ enum: DataRequestStatus })
  @IsOptional()
  @IsEnum(DataRequestStatus)
  status?: DataRequestStatus;

  @ApiPropertyOptional({ enum: DataRequestType })
  @IsOptional()
  @IsEnum(DataRequestType)
  type?: DataRequestType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AssignDataRequestDto {
  @ApiProperty()
  @IsUUID()
  assignedToId!: string;
}

export class ReviewDataRequestDto {
  @ApiProperty({
    enum: ['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'],
  })
  @IsIn(['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'])
  decision!: 'UNDER_REVIEW' | 'ACTION_REQUIRED' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({
    description: 'Required for ACTION_REQUIRED and REJECTED',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}

export class CompleteDataRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}

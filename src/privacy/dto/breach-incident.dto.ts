import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BreachContainmentStatus,
  BreachNotificationStatus,
  BreachSeverity,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBreachDto {
  @ApiProperty() @IsDateString() detectedAt!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reportedBy?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  affectedSystem?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataCategories?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  affectedUsersCount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
  @ApiPropertyOptional({ enum: BreachSeverity })
  @IsOptional()
  @IsEnum(BreachSeverity)
  severity?: BreachSeverity;
  @ApiPropertyOptional({ enum: BreachContainmentStatus })
  @IsOptional()
  @IsEnum(BreachContainmentStatus)
  containmentStatus?: BreachContainmentStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  investigation?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  actionsTaken?: string;
  @ApiPropertyOptional({ enum: BreachNotificationStatus })
  @IsOptional()
  @IsEnum(BreachNotificationStatus)
  notificationStatus?: BreachNotificationStatus;
}

export class UpdateBreachDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() detectedAt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reportedBy?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  affectedSystem?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataCategories?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  affectedUsersCount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
  @ApiPropertyOptional({ enum: BreachSeverity })
  @IsOptional()
  @IsEnum(BreachSeverity)
  severity?: BreachSeverity;
  @ApiPropertyOptional({ enum: BreachContainmentStatus })
  @IsOptional()
  @IsEnum(BreachContainmentStatus)
  containmentStatus?: BreachContainmentStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  investigation?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  actionsTaken?: string;
  @ApiPropertyOptional({ enum: BreachNotificationStatus })
  @IsOptional()
  @IsEnum(BreachNotificationStatus)
  notificationStatus?: BreachNotificationStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  resolution?: string;
}

export class CloseBreachDto {
  @ApiProperty() @IsString() @MaxLength(5000) resolution!: string;
}

export class ListBreachesQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'] })
  @IsOptional()
  @IsEnum({ OPEN: 'OPEN', CLOSED: 'CLOSED' })
  status?: 'OPEN' | 'CLOSED';

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

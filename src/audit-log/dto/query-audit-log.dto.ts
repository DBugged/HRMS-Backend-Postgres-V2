import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { AuditModule } from '@prisma/client';

export class QueryAuditLogDto {
  @ApiPropertyOptional({ enum: AuditModule })
  @IsOptional()
  @IsEnum(AuditModule)
  module?: AuditModule;

  @ApiPropertyOptional({ description: 'Actor user id' })
  @IsOptional()
  @IsUUID()
  actor?: string;

  @ApiPropertyOptional({ description: 'Substring match against action' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

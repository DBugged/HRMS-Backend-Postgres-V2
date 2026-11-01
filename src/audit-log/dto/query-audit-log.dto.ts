import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min, IsIn, IsBoolean } from 'class-validator';
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

  @ApiPropertyOptional({ enum: ['SUCCESS', 'FAILURE'], description: 'FAILURE = refused or denied attempts' })
  @IsOptional()
  @IsIn(['SUCCESS', 'FAILURE'])
  outcome?: 'SUCCESS' | 'FAILURE';

  @ApiPropertyOptional({ description: 'Leave out sign-in entries, which are the bulk of the trail' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  hideSignIns?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

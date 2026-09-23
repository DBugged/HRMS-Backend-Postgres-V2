import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { AssetCondition, AssetInventoryStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export class ListAssetsQueryDto {
  @ApiPropertyOptional({ enum: AssetInventoryStatus })
  @IsOptional()
  @IsEnum(AssetInventoryStatus)
  status?: AssetInventoryStatus;

  @ApiPropertyOptional({ enum: AssetCondition })
  @IsOptional()
  @IsEnum(AssetCondition)
  condition?: AssetCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ description: 'Matches code/name/tag/serial/brand' })
  @IsOptional()
  @IsString()
  search?: string;

  // Soft-deleted assets are hidden by default; pass true to include them.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

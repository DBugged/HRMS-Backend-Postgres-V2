import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEmployeeAssetDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  assetType!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  assetName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetTag?: string;

  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'allocatedDate must be in YYYY-MM-DD format' })
  allocatedDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  // Optional link to an Asset Inventory master record. When present, the
  // asset's name/tag/category are copied from inventory (overriding
  // whatever the free-text fields above carried) and the inventory record
  // flips to ASSIGNED. When absent, this endpoint behaves exactly as it
  // always has — the free-text allocation flow is unchanged.
  @ApiPropertyOptional({ description: 'Asset Inventory record to allocate' })
  @IsOptional()
  @IsString()
  assetId?: string;
}

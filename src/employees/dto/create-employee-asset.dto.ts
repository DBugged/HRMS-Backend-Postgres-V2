import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

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
  @IsValidCalendarDateString()
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

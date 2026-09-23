import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

// Excel/CSV import row — same shape Add Asset collects, except `category`
// is a plain name (resolved case-insensitively against the org's
// ASSET_CATEGORY list server-side, same convention as Employees' bulk
// import resolving Department/Role by name) instead of an OrgListItem id,
// and `condition`/`status` are optional strings (validated/defaulted in
// the service) since a spreadsheet cell can't carry an enum type.
export class BulkImportAssetRowDto {
  @IsOptional()
  @IsString()
  assetCode?: string;

  @IsString()
  assetName!: string;

  @IsString()
  category!: string;

  @IsOptional()
  @IsString()
  categorySpecify?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  assetTag?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsString()
  purchasedFrom!: string;

  @IsString()
  purchaseDate!: string;

  @IsOptional()
  @IsString()
  purchaseCost?: string;

  @IsOptional()
  @IsString()
  vendorContact?: string;

  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @IsString()
  poNumber?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  condition?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  usefulLifeMonths?: string;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class BulkImportAssetsDto {
  @ApiProperty({ type: [BulkImportAssetRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkImportAssetRowDto)
  rows!: BulkImportAssetRowDto[];
}

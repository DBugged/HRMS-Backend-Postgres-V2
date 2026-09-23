import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetCondition, AssetInventoryStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

// Dates arrive as plain YYYY-MM-DD strings (same convention as every other
// date-carrying DTO in this app — see CreateEmployeeAssetDto.allocatedDate)
// and are widened to a DateTime by the service.
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAssetDto {
  // Optional — the service auto-generates AST-0001-style codes when the
  // caller leaves this blank.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetCode?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  assetName!: string;

  @ApiProperty({ description: 'OrgListItem id of type ASSET_CATEGORY' })
  @IsNotEmpty()
  @IsString()
  categoryId!: string;

  // Required by the service only when the chosen category is named "Other".
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categorySpecify?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetTag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  purchasedFrom!: string;

  @ApiProperty({ example: '2026-06-10' })
  @Matches(DATE_RE, { message: 'purchaseDate must be in YYYY-MM-DD format' })
  purchaseDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'purchaseCost cannot be negative.' })
  purchaseCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  poNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({ enum: AssetCondition })
  @IsEnum(AssetCondition)
  condition!: AssetCondition;

  @ApiProperty({ enum: AssetInventoryStatus })
  @IsEnum(AssetInventoryStatus)
  status!: AssetInventoryStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  usefulLifeMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  // --- Warranty (also settable on its own via PATCH /assets/:id/warranty) ---

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyNumber?: string;

  @ApiPropertyOptional({ example: '2026-06-10' })
  @IsOptional()
  @Matches(DATE_RE, {
    message: 'warrantyStartDate must be in YYYY-MM-DD format',
  })
  warrantyStartDate?: string;

  @ApiPropertyOptional({ example: '2028-06-09' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'warrantyEndDate must be in YYYY-MM-DD format' })
  warrantyEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  warrantyPeriodMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warrantyTerms?: string;
}

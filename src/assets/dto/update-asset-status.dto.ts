import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetInventoryStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateAssetStatusDto {
  // ASSIGNED is deliberately NOT reachable here — an asset only becomes
  // ASSIGNED as a side effect of the Employees module allocating it, never
  // by someone flipping a status field in the inventory screen.
  @ApiProperty({ enum: AssetInventoryStatus })
  @IsEnum(AssetInventoryStatus)
  status!: AssetInventoryStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}

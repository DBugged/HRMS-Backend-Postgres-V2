import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateCompanyBrandDto } from './create-company-brand.dto';

export class UpdateCompanyBrandDto extends PartialType(CreateCompanyBrandDto) {
  @ApiPropertyOptional({ description: 'false stops new employees being given this brand; people already on it keep it.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

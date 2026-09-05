import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { OrgListType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

export class ListOrgListItemsQueryDto {
  @ApiPropertyOptional({ enum: OrgListType })
  @IsOptional()
  @IsEnum(OrgListType)
  type?: OrgListType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  activeOnly?: boolean;
}

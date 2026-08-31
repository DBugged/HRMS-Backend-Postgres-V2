import { ApiProperty } from '@nestjs/swagger';
import { OrgListType } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

export class CreateOrgListItemDto {
  @ApiProperty({ enum: OrgListType })
  @IsEnum(OrgListType)
  type!: OrgListType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;
}

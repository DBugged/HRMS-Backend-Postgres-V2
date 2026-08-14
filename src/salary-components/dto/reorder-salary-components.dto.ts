import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsUUID, ValidateNested } from 'class-validator';

class ReorderEntryDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsInt()
  displayOrder!: number;
}

export class ReorderSalaryComponentsDto {
  @ApiProperty({ type: [ReorderEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  order!: ReorderEntryDto[];
}

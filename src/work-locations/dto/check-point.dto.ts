import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber } from 'class-validator';

export class CheckPointDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;
}

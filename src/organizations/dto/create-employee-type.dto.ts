import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateEmployeeTypeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  label!: string;
}

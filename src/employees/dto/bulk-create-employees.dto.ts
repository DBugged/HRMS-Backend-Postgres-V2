import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class BulkEmployeeRowDto {
  @ApiProperty()
  @IsNotEmpty()
  name!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  designation?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  contactNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  joiningDate?: string;
}

export class BulkCreateEmployeesDto {
  @ApiProperty({ type: [BulkEmployeeRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkEmployeeRowDto)
  rows!: BulkEmployeeRowDto[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Jane Employee' })
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'jane@acme.test' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  designation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @ApiPropertyOptional({
    enum: Role,
    description: 'Defaults to EMPLOYEE. HR cannot assign ADMIN.',
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  @ApiPropertyOptional({ example: 'permanent' })
  @IsOptional()
  @IsString()
  employeeType?: string;
}

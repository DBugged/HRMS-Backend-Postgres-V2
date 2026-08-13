import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Role } from '@prisma/client';

export class ListEmployeesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Matches against name, email, or employeeId',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description:
      'Ignored for MANAGER callers — always forced to their own department',
  })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

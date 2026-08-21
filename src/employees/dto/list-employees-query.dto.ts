import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
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

  // No cap previously — a client could pass an arbitrarily large limit and
  // force a fully unbounded findMany, same class of issue QueryPayrollDto/
  // QueryAttendanceDto already guard against. Capped at 2000 to match the
  // convention used by every other paginated list DTO in this codebase.
  @ApiPropertyOptional({ default: 20, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
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

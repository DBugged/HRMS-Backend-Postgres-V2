import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @IsNotEmpty()
  name!: string;

  // Uppercased in DepartmentsService.create() — Prisma has no model-level
  // hooks (unlike the old Sequelize model's beforeValidate).
  @ApiProperty({ example: 'ENG' })
  @IsNotEmpty()
  @IsString()
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

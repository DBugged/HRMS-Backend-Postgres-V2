import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

  @ApiPropertyOptional({ example: '09:30' })
  @IsOptional()
  @IsString()
  shiftStartTime?: string;

  @ApiPropertyOptional({ example: '18:30' })
  @IsOptional()
  @IsString()
  shiftEndTime?: string;

  @ApiPropertyOptional({
    type: [Number],
    description: '0=Sunday ... 6=Saturday',
  })
  @IsOptional()
  @IsArray()
  weeklyOffs?: number[];
}

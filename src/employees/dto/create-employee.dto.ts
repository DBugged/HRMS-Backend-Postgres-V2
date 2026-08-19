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

  // Optional at this DTO/type level so bulkCreate's row shape (no
  // per-row personalEmail column in the Excel import) keeps working
  // unchanged — the single "Add Employee" form enforces it as required
  // client-side instead, since that's the flow this actually matters for.
  // When present, EmployeesService.create() routes it into personalData and
  // sends the welcome email (login URL, employee ID, generated password);
  // when absent (bulk-imported rows), no email is sent, matching today's
  // fallback of returning the password in the response only.
  @ApiPropertyOptional({ example: 'jane.personal@gmail.com' })
  @IsOptional()
  @IsEmail()
  personalEmail?: string;

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

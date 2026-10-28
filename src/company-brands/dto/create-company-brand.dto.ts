import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { NormalizeEmail, Trim } from '../../common/normalize-input';
import { EMPLOYEE_ID_FORMAT_MESSAGE } from '../brand-rules';

const FORMAT = /^[A-Za-z0-9_\-./]{1,12}\{\d{3,8}\}$/;

export class CreateCompanyBrandDto {
  @ApiProperty({ example: 'Sister A Pvt Ltd', description: 'The name shown on payslips, letters and emails.' })
  @Trim()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  legalName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Stored file key of the logo (from the branding upload).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Stored file key of the logo used in emails; the logo is used when blank.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  emailLogoUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NormalizeEmail()
  @IsOptional()
  @IsEmail()
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'SA-{00000}', description: 'This brand\'s own employee ID series; blank = the company series.' })
  @IsOptional()
  @IsString()
  @Matches(FORMAT, { message: EMPLOYEE_ID_FORMAT_MESSAGE })
  employeeIdFormat?: string | null;

  @ApiPropertyOptional({ example: 1, description: 'The first number of the series (default 1). Only used when the format is set.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99999999)
  employeeIdStart?: number;

  @ApiPropertyOptional({ description: 'New employees get this brand unless another is picked. Only one brand is the default.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

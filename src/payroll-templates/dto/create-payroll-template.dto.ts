import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { HeaderStyle, PayslipFontFamily } from '@prisma/client';

export class CreatePayrollTemplateDto {
  @ApiPropertyOptional({ default: 'Default Template' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description:
      'Forced true regardless of this value if the org has no templates yet',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyLogoUrl?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyAddress?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyEmail?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyWebsite?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyContactNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  primaryColor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  secondaryColor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accentColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  footerText?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signatoryName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signatoryDesignation?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  watermarkText?: string;

  @ApiPropertyOptional({ enum: HeaderStyle })
  @IsOptional()
  @IsEnum(HeaderStyle)
  headerStyle?: HeaderStyle;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  headerColor?: string;
  @ApiPropertyOptional({ enum: PayslipFontFamily })
  @IsOptional()
  @IsEnum(PayslipFontFamily)
  fontFamily?: PayslipFontFamily;
  @ApiPropertyOptional({ default: 9 })
  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(14)
  fontSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showCompanyAddress?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showPAN?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showUAN?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showESIC?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showPFNumber?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showBankDetails?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showEmployerContributions?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showCTC?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showYTD?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showQRCode?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showFooter?: boolean;
}

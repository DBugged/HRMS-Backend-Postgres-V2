import { IsIndianMobile } from '../../common/indian-mobile';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

// Plain text only: no angle brackets (markup) in anything that is printed on a payslip.
const PLAIN_TEXT = /^[^<>]*$/;
const PLAIN_TEXT_MESSAGE = '$property cannot contain < or > characters';
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HEX_MESSAGE = '$property must be a hex color such as #5546e0';
// Never an address on someone else's server: a stored file key or one of our own signed /files/ paths.
const OWN_FILE = /^(?![a-z][a-z0-9+.-]*:|\/\/)[^<>"'\s]{1,2000}$/i;
import { HeaderStyle, PayslipFontFamily } from '@prisma/client';

export class CreatePayrollTemplateDto {
  @ApiPropertyOptional({ default: 'Default Template' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
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
  @Matches(OWN_FILE, {
    message: 'companyLogoUrl must be an image uploaded to this organization',
  })
  companyLogoUrl?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  companyName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  companyAddress?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o: CreatePayrollTemplateDto) => o.companyEmail !== '')
  @IsEmail()
  @MaxLength(150)
  companyEmail?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^$|^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/, {
    message:
      'companyWebsite must be a web address starting with http:// or https://',
  })
  companyWebsite?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsIndianMobile()
  companyContactNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  primaryColor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  secondaryColor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  accentColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  footerText?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  signatoryName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  signatoryDesignation?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(PLAIN_TEXT, { message: PLAIN_TEXT_MESSAGE })
  watermarkText?: string;

  @ApiPropertyOptional({ enum: HeaderStyle })
  @IsOptional()
  @IsEnum(HeaderStyle)
  headerStyle?: HeaderStyle;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
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

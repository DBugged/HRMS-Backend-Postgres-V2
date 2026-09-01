import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateEmailTemplateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  subject!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  bodyHtml!: string;

  // Defaults to false, unlike the seeded Birthday/Work Anniversary
  // templates — an ad-hoc custom send is usually meant for specific
  // recipients, not cc'd to the entire company by default.
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  ccAllActive?: boolean;

  // Which of the org's named signatures (see Organization.emailSignatures)
  // this template uses — omitted/empty means "whichever has isDefault:true".
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signatureId?: string;
}

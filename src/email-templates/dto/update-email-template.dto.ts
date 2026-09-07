import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { EMAIL_TEMPLATE_CATEGORIES } from '../email-template-categories';

export class UpdateEmailTemplateDto {
  @ApiPropertyOptional({ example: 'Birthday Wish' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Happy Birthday, {{employeeName}}!' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ example: '<p>Happy Birthday, {{employeeName}}!</p>' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  bodyHtml?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  ccAllActive?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Which of the org's named signatures (see Organization.emailSignatures)
  // this template uses — '' clears it back to "whichever has
  // isDefault:true"; omitted leaves the current value unchanged.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signatureId?: string;

  // Re-groups this template on the Email Templates table — editable for
  // both built-in and custom templates, same as any other field here.
  @ApiPropertyOptional({ enum: EMAIL_TEMPLATE_CATEGORIES })
  @IsOptional()
  @IsIn(EMAIL_TEMPLATE_CATEGORIES)
  category?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Both optional — an unedited Send keeps sending the template's own
// rendered content exactly as before this existed. When present and
// non-blank, LettersService.generate() uses this text verbatim (no
// {{placeholder}} substitution — it's already-rendered, human-edited text)
// instead of the template's computed title/body, for this one send only;
// the stored LetterTemplate is never touched.
export class SendLetterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  body?: string;
}

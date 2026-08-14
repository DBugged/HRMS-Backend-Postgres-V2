import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateChecklistDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  assetsReturned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  accessRevoked?: boolean;
}

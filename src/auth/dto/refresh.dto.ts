import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// Optional because web clients rely on the httpOnly cookie instead — see
// AuthController.refresh() for how the two sources are reconciled.
export class RefreshDto {
  @ApiPropertyOptional({
    description: 'Only needed for clients without a cookie jar (mobile).',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

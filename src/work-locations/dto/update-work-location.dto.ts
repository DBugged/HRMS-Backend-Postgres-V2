import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { CreateWorkLocationDto } from './create-work-location.dto';

// All geometry fields (fenceType/boundary/latitude/longitude/radiusMeters)
// are re-validated together only if any of them is touched — see
// WorkLocationsService.update(). Any other field (name/address/description/
// isActive) passes through unchanged, so a caller that only toggles
// isActive is unaffected by geometry rules entirely.
export class UpdateWorkLocationDto extends PartialType(CreateWorkLocationDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

import { PartialType } from '@nestjs/swagger';
import { CreateAssetMaintenanceDto } from './create-asset-maintenance.dto';

export class UpdateAssetMaintenanceDto extends PartialType(
  CreateAssetMaintenanceDto,
) {}

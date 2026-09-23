import { PartialType } from '@nestjs/swagger';
import { CreateAssetDto } from './create-asset.dto';

// Every field optional — the service applies the same cross-field checks
// (unique tag/serial, purchaseCost >= 0, warranty end >= start) against the
// merged result, so a partial edit can't sneak past a rule create enforces.
export class UpdateAssetDto extends PartialType(CreateAssetDto) {}

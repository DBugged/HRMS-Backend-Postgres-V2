import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class LinkSettlementDto {
  @ApiProperty()
  @IsUUID()
  settlementId!: string;
}

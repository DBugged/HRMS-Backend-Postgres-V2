import { PartialType } from '@nestjs/swagger';
import { CreateWeeklyOffPatternDto } from './create-weekly-off-pattern.dto';

export class UpdateWeeklyOffPatternDto extends PartialType(CreateWeeklyOffPatternDto) {}

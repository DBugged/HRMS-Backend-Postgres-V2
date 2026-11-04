// Purpose: Endpoints for gender-wise shift rules. Reads of a person's own shift are open to any signed-in user.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { ShiftRulesService } from './shift-rules.service';
import { SaveShiftRuleDto, RecalculateShiftRulesDto } from './dto/shift-rule.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('shift-rules')
@ApiBearerAuth('access-token')
@Controller('shift-rules')
export class ShiftRulesController {
  constructor(private readonly rules: ShiftRulesService) {}

  // No @Roles(): the shift that applies to the caller (department shift or the gender rule's timing).
  @Get('mine')
  mine(@CurrentUser() caller: Caller) {
    return this.rules.mine(caller.id, caller.organizationId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  list(@CurrentUser() caller: Caller) {
    return this.rules.list(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: SaveShiftRuleDto, @CurrentUser() caller: Caller) {
    return this.rules.create(dto, caller.organizationId, caller);
  }

  // Judges attendance already recorded again under the rules as they now stand. Before the :id routes.
  @Post('recalculate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  recalculate(@Body() dto: RecalculateShiftRulesDto, @CurrentUser() caller: Caller) {
    return this.rules.recalculate(dto, caller.organizationId, caller);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: SaveShiftRuleDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.rules.update(id, dto, caller.organizationId, caller);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.rules.remove(id, caller.organizationId, caller);
  }
}

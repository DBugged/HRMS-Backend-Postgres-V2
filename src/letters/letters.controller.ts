// Purpose: Exposes letter generation as a PDF download, mounted at /employees/:id/letters/:key — key is a
//   LetterTemplate's key (see letter-templates module), not a fixed set: any active template, built-in or
//   admin-created custom, is downloadable here. Also exposes :key/content — GET returns the same title/body
//   as plain editable text (for the Send modal's edit step), PUT saves an edit as this employee's new
//   default (a LetterOverride — Download and future Sends then use it too), DELETE clears it back to the
//   template's own rendering — and :key/send, which generates the PDF (using a per-request title/body if
//   given, else the saved override if any, else the template) and emails it. See LettersService.
// Important: Self-or-role scoped (self, or ADMIN/HR/MANAGER — MANAGER further restricted to own
//   department in the service), same pattern as /employees/:id/timeline. :key/content and :key/send are
//   narrower — ADMIN/HR only, not self or MANAGER: emailing someone official correspondence (and editing
//   it beforehand) is an HR action, not something an employee (who can already download their own copy)
//   or a department head needs to do.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { LettersService } from './letters.service';
import { SendLetterDto } from './dto/send-letter.dto';
import { SaveLetterContentDto } from './dto/save-letter-content.dto';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

@ApiTags('letters')
@ApiBearerAuth('access-token')
@Controller('employees/:id/letters')
export class LettersController {
  constructor(private readonly lettersService: LettersService) {}

  // Must be declared before ':key' — Nest matches routes in registration
  // order, and ':key' would otherwise swallow this literal path.
  @Get()
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  async list(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.lettersService.listForEmployee(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Get(':key')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async generate(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.lettersService.generate(
      id,
      key,
      caller,
      caller.organizationId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buffer);
  }

  // Text-only counterpart to :key — same rendered title/body, no PDF, no
  // document number issued — used to seed the Send modal's editable
  // Title/Body fields before HR decides whether to change anything.
  @Get(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async previewContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.previewContent(
      id,
      key,
      caller,
      caller.organizationId,
    );
  }

  // Saves HR's edited title/body as this employee's new default for this
  // letter key — Download and every future unedited Send pick it up from
  // here on, until DELETE :key/content resets it.
  @Put(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async saveContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SaveLetterContentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.saveOverride(
      id,
      key,
      caller,
      caller.organizationId,
      {
        title: dto.title,
        body: dto.body,
      },
    );
  }

  // Clears a saved override — Download/Send fall back to the template's
  // own rendering again. Not a 404 when nothing was saved.
  @Delete(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async resetContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.resetOverride(
      id,
      key,
      caller,
      caller.organizationId,
    );
  }

  @Post(':key/send')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async send(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SendLetterDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.send(id, key, caller, caller.organizationId, {
      title: dto.title,
      body: dto.body,
    });
  }
}

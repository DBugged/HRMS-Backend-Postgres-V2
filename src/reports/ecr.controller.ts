// Purpose: The EPFO ECR upload file for a month — a JSON pre-upload check and the .txt download.
// Important: ADMIN/HR only, audited as an export. A file with blocking issues (e.g. a member without a UAN) is
//   refused unless the caller explicitly asks to leave those members out.
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ExportAuditInterceptor } from '../common/sensitive-audit';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EcrService } from './ecr.service';

type Caller = Omit<User, 'password'>;

export class EcrQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  skipInvalid?: boolean;
}

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/payroll/pf-ecr')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class EcrController {
  constructor(private readonly ecrService: EcrService) {}

  @Get('preview')
  async preview(@Query() q: EcrQueryDto, @CurrentUser() c: Caller) {
    const r = await this.ecrService.build(q.month, q.year, c.organizationId, {
      skipInvalid: true,
    });
    // The file body is not part of the check response.
    const { content: _content, ...rest } = r;
    void _content;
    return rest;
  }

  @Get()
  @UseInterceptors(ExportAuditInterceptor)
  async download(
    @Query() q: EcrQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const r = await this.ecrService.build(q.month, q.year, c.organizationId, {
      skipInvalid: q.skipInvalid ?? false,
    });
    if (r.members === 0) {
      throw new BadRequestException(
        'No PF members found in locked payroll for this month — nothing to upload.',
      );
    }
    if (r.errors.length > 0 && !q.skipInvalid) {
      throw new BadRequestException(
        `The ECR cannot be uploaded as is: ${r.errors
          .slice(0, 5)
          .map((e) => `${e.name} — ${e.message}`)
          .join(
            ' | ',
          )}${r.errors.length > 5 ? ` (+${r.errors.length - 5} more)` : ''}`,
      );
    }
    if (r.lines === 0) {
      throw new BadRequestException(
        'Every PF member has a blocking problem, so there is nothing to upload — see the check for details.',
      );
    }
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${r.fileName}"`,
      'X-ECR-Members': String(r.lines),
      'X-ECR-Skipped': String(r.errors.length),
    });
    res.end(r.content);
  }
}

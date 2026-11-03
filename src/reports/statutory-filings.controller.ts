// Purpose: the statutory filing tracker - every PF / ESI / PT / TDS / 24Q / LWF due date around today, whether it has been filed, and a
//   one-click link to the return file for the ones the app can produce (ECR, ESIC, PT).
// Responsibilities: lists the dues from the shared calendar (reminder-dates.ts) with filed / pending / overdue, and records or clears
//   "filed". Does not file anything with the authorities.
// Important: Admin and HR only. The due dates are reminders (the calendar tells HR to confirm the date for their registration category).
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { IsBoolean, IsIn, Matches } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { upcomingStatutoryDues } from '../scheduled-reminders/reminder-dates';

type Caller = Omit<User, 'password'>;

const KEYS = ['PF', 'ESI', 'PT', 'TDS', '24Q', 'LWF'];

class MarkFiledDto {
  @IsIn(KEYS) key!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate!: string;
  @IsBoolean() filed!: boolean;
}

// The return file for a due, when the app can make one: the contribution month is the month before the due date's month.
const FILE_PATH: Record<string, string> = { PF: 'reports/payroll/pf-ecr', ESI: 'reports/payroll/esic-return', PT: 'reports/payroll/pt-return' };

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/statutory-tracker')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class StatutoryFilingsController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  @Get()
  async list(@CurrentUser() caller: Caller) {
    const org = await this.prisma.organization.findFirst({ where: { id: caller.organizationId }, select: { timezone: true } });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const versions = await this.prisma.statutoryConfigVersion.findMany({
      where: { organizationId: caller.organizationId, isEnabled: true, module: { in: ['PF', 'ESI', 'PT', 'LWF'] }, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
      select: { module: true },
    });
    const window = Array.from({ length: 91 }, (_, i) => i - 45);
    const dues = upcomingStatutoryDues(today, new Set(versions.map((v) => v.module)), window);
    const filings = await this.prisma.statutoryFiling.findMany({ where: { organizationId: caller.organizationId } });
    const filed = new Map(filings.map((f) => [`${f.key}|${f.dueDate}`, f]));
    const items = dues.map((d) => {
      const f = filed.get(`${d.key}|${d.dueDate}`);
      const [y, m] = d.dueDate.split('-').map(Number);
      const contribMonth = m === 1 ? 12 : m - 1;
      const contribYear = m === 1 ? y - 1 : y;
      return {
        key: d.key,
        label: d.label,
        period: d.period,
        dueDate: d.dueDate,
        daysLeft: d.daysLeft,
        status: f ? 'filed' : d.daysLeft < 0 ? 'overdue' : 'pending',
        filedAt: f?.filedAt ?? null,
        file: FILE_PATH[d.key] ? { path: FILE_PATH[d.key], month: contribMonth, year: contribYear } : null,
      };
    });
    return { items };
  }

  @Post('mark')
  async mark(@Body() dto: MarkFiledDto, @CurrentUser() caller: Caller) {
    const where = { organizationId_key_dueDate: { organizationId: caller.organizationId, key: dto.key, dueDate: dto.dueDate } };
    if (dto.filed) {
      await this.prisma.statutoryFiling.upsert({
        where,
        create: { organizationId: caller.organizationId, key: dto.key, dueDate: dto.dueDate, filedById: caller.id },
        update: {},
      });
    } else {
      await this.prisma.statutoryFiling.deleteMany({ where: { organizationId: caller.organizationId, key: dto.key, dueDate: dto.dueDate } });
    }
    return { ok: true };
  }
}

// Purpose: Stores and serves per-employee opening balances (year so far before payroll began here).
// Responsibilities: list / set / clear one employee's balance, and bulk import by employee code with per-row errors.
// Important: one balance per employee per financial year. The tax engine reads the table directly (PayrollService).
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { AuditLogService } from '../audit-log/audit-log.service';
import { monthsBeforeInFY, validateOpeningBalance } from './opening-balances';
import {
  OpeningBalanceDto,
  OpeningBalanceImportRowDto,
} from './dto/opening-balance.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly settings: PayrollSettingsService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async context(organizationId: string, month?: number, year?: number) {
    const s = await this.settings.getOrCreate(organizationId);
    const now = new Date();
    const m = month ?? now.getUTCMonth() + 1;
    const y = year ?? now.getUTCFullYear();
    return {
      financialYear: getFinancialYear(m, y, s.financialYearStartMonth),
      maxMonths: monthsBeforeInFY(m, s.financialYearStartMonth),
    };
  }

  async list(organizationId: string, month?: number, year?: number) {
    const ctx = await this.context(organizationId, month, year);
    const [employees, balances] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          organizationId,
          isActive: true,
          excludeFromPayroll: false,
          role: { in: [Role.EMPLOYEE, Role.MANAGER, Role.HR, Role.ADMIN] },
        },
        select: { id: true, name: true, employeeId: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employeeOpeningBalance.findMany({
        where: { organizationId, financialYear: ctx.financialYear },
      }),
    ]);
    const byEmployee = new Map(balances.map((b) => [b.employeeId, b]));
    return {
      ...ctx,
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        code: e.employeeId ?? '',
        balance: byEmployee.get(e.id) ?? null,
      })),
    };
  }

  async get(
    employeeId: string,
    organizationId: string,
    month?: number,
    year?: number,
  ) {
    const ctx = await this.context(organizationId, month, year);
    const balance = await this.prisma.employeeOpeningBalance.findFirst({
      where: { organizationId, employeeId, financialYear: ctx.financialYear },
    });
    return { ...ctx, balance };
  }

  private async save(
    employeeId: string,
    dto: OpeningBalanceDto,
    ctx: { financialYear: string; maxMonths: number },
    actor: Actor,
    organizationId: string,
  ) {
    const values = {
      monthsCovered: dto.monthsCovered,
      taxableEarnings: dto.taxableEarnings,
      tdsDeducted: dto.tdsDeducted,
      pfPaid: dto.pfPaid ?? 0,
      ptPaid: dto.ptPaid ?? 0,
    };
    const problem = validateOpeningBalance(values, ctx.maxMonths);
    if (problem) throw new BadRequestException(problem);
    const where = {
      organizationId,
      employeeId,
      financialYear: ctx.financialYear,
    };
    const existing = await this.prisma.employeeOpeningBalance.findFirst({
      where,
    });
    if (existing) {
      await this.prisma.employeeOpeningBalance.updateMany({
        where: { id: existing.id, organizationId },
        data: { updatedById: actor.id, ...values },
      });
    } else {
      await this.prisma.employeeOpeningBalance.create({
        data: { ...where, updatedById: actor.id, ...values },
      });
    }
    const saved = await this.prisma.employeeOpeningBalance.findFirst({ where });
    await this.auditLog.log({
      actorId: actor.id,
      action: 'OPENING_BALANCE_SET',
      module: 'PAYROLL',
      organizationId,
      targetId: employeeId,
      details: { financialYear: ctx.financialYear, ...values },
    });
    return saved;
  }

  async set(
    employeeId: string,
    dto: OpeningBalanceDto,
    actor: Actor,
    organizationId: string,
    month?: number,
    year?: number,
  ) {
    const employee = await this.prisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const ctx = await this.context(organizationId, month, year);
    return this.save(employeeId, dto, ctx, actor, organizationId);
  }

  async clear(
    employeeId: string,
    actor: Actor,
    organizationId: string,
    month?: number,
    year?: number,
  ) {
    const ctx = await this.context(organizationId, month, year);
    await this.prisma.employeeOpeningBalance.deleteMany({
      where: { organizationId, employeeId, financialYear: ctx.financialYear },
    });
    await this.auditLog.log({
      actorId: actor.id,
      action: 'OPENING_BALANCE_CLEARED',
      module: 'PAYROLL',
      organizationId,
      targetId: employeeId,
      details: { financialYear: ctx.financialYear },
    });
    return { ok: true };
  }

  /** Saves every valid row; a bad row is reported (1-based, as in the file) and skipped, never blocking the rest. */
  async importRows(
    rows: OpeningBalanceImportRowDto[],
    actor: Actor,
    organizationId: string,
    month?: number,
    year?: number,
  ) {
    const ctx = await this.context(organizationId, month, year);
    const codes = [...new Set(rows.map((r) => r.employeeCode.trim()))];
    const employees = await this.prisma.user.findMany({
      where: { organizationId, employeeId: { in: codes } },
      select: { id: true, employeeId: true },
    });
    const byCode = new Map(employees.map((e) => [e.employeeId, e.id]));
    const seen = new Set<string>();
    const errors: { row: number; code: string; message: string }[] = [];
    let saved = 0;
    for (const [i, r] of rows.entries()) {
      const code = r.employeeCode.trim();
      const id = byCode.get(code);
      const fail = (message: string) =>
        errors.push({ row: i + 1, code, message });
      if (!id) {
        fail('Employee code not found.');
        continue;
      }
      if (seen.has(code)) {
        fail('Employee appears twice.');
        continue;
      }
      seen.add(code);
      try {
        await this.save(id, r, ctx, actor, organizationId);
        saved++;
      } catch (e) {
        fail(e instanceof BadRequestException ? e.message : 'Could not save.');
      }
    }
    return { saved, errors };
  }
}

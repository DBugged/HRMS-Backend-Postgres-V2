// Purpose: HR/Admin-entered company (or department) achievement % per financial year, which scales
//   variable pay while PayrollSettings.companyPerformanceEnabled is on (see payroll/variable-pay.ts).
// Responsibilities: list / upsert / delete the percentages, and report whose variable pay is currently
//   held waiting for one. The payroll calculation itself reads the table directly.
// Important: One company-wide row (departmentId null) per org+financial year, enforced here because
//   Postgres treats NULLs as distinct in the unique index; a department row overrides it.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { wrapAll } from '../common/pagination';
import { SetCompanyPerformanceDto } from './dto/set-company-performance.dto';
import {
  pendingHolds,
  releasedKeys,
  type HeldVariablePay,
} from '../payroll/variable-pay';

@Injectable()
export class CompanyPerformanceService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string, financialYear?: string) {
    const rows = await this.scopedPrisma.companyPerformance.findMany({
      where: { organizationId, ...(financialYear ? { financialYear } : {}) },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ financialYear: 'desc' }, { departmentId: 'asc' }],
    });
    return wrapAll(rows);
  }

  async set(
    dto: SetCompanyPerformanceDto,
    actorId: string,
    organizationId: string,
  ) {
    const [startYear, endYY] = dto.financialYear.split('-').map(Number);
    if ((startYear + 1) % 100 !== endYY) {
      throw new BadRequestException(
        `Financial year ${dto.financialYear} isn't consecutive — did you mean ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}?`,
      );
    }
    const departmentId = dto.departmentId ?? null;
    if (departmentId) {
      const dept = await this.scopedPrisma.department.findFirst({
        where: { id: departmentId, organizationId },
        select: { id: true },
      });
      if (!dept) throw new NotFoundException('Department not found.');
    }

    const existing = await this.scopedPrisma.companyPerformance.findFirst({
      where: { organizationId, financialYear: dto.financialYear, departmentId },
    });
    const data = {
      achievementPercent: dto.achievementPercent,
      notes: dto.notes ?? '',
      updatedById: actorId,
    };
    let id: string;
    if (existing) {
      await this.scopedPrisma.companyPerformance.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      id = existing.id;
    } else {
      const created = await this.scopedPrisma.companyPerformance.create({
        data: {
          organizationId,
          financialYear: dto.financialYear,
          departmentId,
          createdById: actorId,
          ...data,
        },
      });
      id = created.id;
    }

    await this.auditLogService.log({
      actorId,
      action: 'COMPANY_PERFORMANCE_SET',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        financialYear: dto.financialYear,
        departmentId,
        achievementPercent: dto.achievementPercent,
        previousPercent: existing?.achievementPercent ?? null,
        notes: data.notes,
      },
    });
    return this.scopedPrisma.companyPerformance.findFirstOrThrow({
      where: { id, organizationId },
      include: { department: { select: { id: true, name: true } } },
    });
  }

  async remove(id: string, actorId: string, organizationId: string) {
    const row = await this.scopedPrisma.companyPerformance.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Entry not found.');
    await this.scopedPrisma.companyPerformance.deleteMany({
      where: { id, organizationId },
    });
    await this.auditLogService.log({
      actorId,
      action: 'COMPANY_PERFORMANCE_REMOVED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        financialYear: row.financialYear,
        departmentId: row.departmentId,
        achievementPercent: row.achievementPercent,
      },
    });
    return { success: true };
  }

  // Employees whose variable pay is held right now (not yet paid by any run),
  // so HR can see what entering a percentage will release.
  async held(organizationId: string) {
    const heldRuns = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        NOT: { heldVariablePay: { equals: [] } },
      },
      select: {
        employeeId: true,
        month: true,
        year: true,
        heldVariablePay: true,
        employee: { select: { name: true, employeeId: true } },
      },
    });
    const employeeIds = [...new Set(heldRuns.map((r) => r.employeeId))];
    if (employeeIds.length === 0) return wrapAll([]);
    const releasedRuns = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, employeeId: { in: employeeIds } },
      select: { employeeId: true, month: true, year: true, earnings: true },
    });

    const out: Array<
      HeldVariablePay & {
        employeeId: string;
        employeeName: string;
        employeeCode: string;
      }
    > = [];
    for (const employeeId of employeeIds) {
      const mine = heldRuns.filter((r) => r.employeeId === employeeId);
      const paid = releasedKeys(
        releasedRuns
          .filter((r) => r.employeeId === employeeId)
          .map((r) => ({ ...r, heldVariablePay: [] })),
      );
      // Any month in the far future so every recorded hold is "earlier".
      for (const h of pendingHolds(
        mine.map((r) => ({ ...r, earnings: [] })),
        12,
        9999,
        paid,
      )) {
        out.push({
          ...h,
          employeeId,
          employeeName: mine[0].employee.name,
          employeeCode: mine[0].employee.employeeId,
        });
      }
    }
    return wrapAll(out);
  }
}

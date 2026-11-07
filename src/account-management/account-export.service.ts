// Purpose: the Company Admin's Data Export: builds a spreadsheet/CSV of one data category for the admin's OWN organisation, keeps
//   a history of exports, and serves each file for 24 hours.
// Important: organizationId always comes from the signed-in user. Each export is capped (EXPORT_ROW_CAP rows); the file is stored
//   under the organisation's own folder and the download re-checks tenant, requester role (controller) and expiry.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { buildWorkbook } from '../reports/report-export';
import type { ReportColumn } from '../reports/report-export';
import { readStoredFile, writeStoredFile } from '../files/file-storage.config';
import { EXPORT_CATEGORIES, EXPORT_LINK_HOURS, EXPORT_ROW_CAP } from './account-logic';

type Caller = Omit<User, 'password'>;
type Table = { columns: ReportColumn[]; rows: Record<string, unknown>[] };
const col = (key: string, header: string, width = 18): ReportColumn => ({ key, header, width });
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : '');
const MONTH_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class AccountExportService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly auditLog: AuditLogService,
  ) {}

  categories() {
    return EXPORT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, dateRange: c.dateRange }));
  }

  async history(organizationId: string) {
    const rows = await this.prisma.ccExport.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      format: r.format,
      status: r.status === 'COMPLETED' && r.expiresAt && r.expiresAt < now ? 'EXPIRED' : r.status,
      rowCount: r.rowCount,
      requestedByName: r.requestedByName,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      error: r.error,
      filters: r.filters,
    }));
  }

  async create(caller: Caller, dto: { category: string; format?: string; from?: string; to?: string }) {
    const cat = EXPORT_CATEGORIES.find((c) => c.key === dto.category);
    if (!cat) throw new BadRequestException('Choose a data category to export.');
    const format = dto.format === 'CSV' ? 'CSV' : 'XLSX';
    if (cat.dateRange) {
      for (const v of [dto.from, dto.to]) if (v && !MONTH_RE.test(v)) throw new BadRequestException('Dates must be YYYY-MM-DD.');
      if (dto.from && dto.to && dto.from > dto.to) throw new BadRequestException('The start date is after the end date.');
    }
    const organizationId = caller.organizationId;
    const filters = cat.dateRange ? { from: dto.from ?? null, to: dto.to ?? null } : {};
    const record = await this.prisma.ccExport.create({
      data: { organizationId, category: cat.key, format, filters, status: 'PROCESSING', requestedById: caller.id, requestedByName: caller.name },
    });
    try {
      const table = await this.generate(organizationId, cat.key, dto.from, dto.to);
      if (table.rows.length > EXPORT_ROW_CAP) throw new BadRequestException(`This export has more than ${EXPORT_ROW_CAP} rows. Narrow the date range.`);
      const wb = buildWorkbook(cat.label, table.columns, table.rows, undefined, null, { styled: format === 'XLSX' });
      const buffer = Buffer.from(format === 'CSV' ? await wb.csv.writeBuffer() : await wb.xlsx.writeBuffer());
      const fileName = `${cat.key.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
      const fileKey = `${organizationId}/account-exports/${record.id}-${fileName}`;
      await writeStoredFile(fileKey, buffer, format === 'CSV' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await this.prisma.ccExport.update({
        where: { id: record.id },
        data: { status: 'COMPLETED', fileKey, fileName, rowCount: table.rows.length, completedAt: new Date(), expiresAt: new Date(Date.now() + EXPORT_LINK_HOURS * 3600_000) },
      });
    } catch (e) {
      const msg = e instanceof BadRequestException ? e.message : 'The export could not be generated.';
      await this.prisma.ccExport.update({ where: { id: record.id }, data: { status: 'FAILED', error: msg } });
      await this.audit(caller, record.id, cat.key, 'FAILURE');
      throw e instanceof BadRequestException ? e : new BadRequestException(msg);
    }
    await this.audit(caller, record.id, cat.key, 'SUCCESS');
    return { id: record.id };
  }

  private audit(caller: Caller, id: string, category: string, outcome: 'SUCCESS' | 'FAILURE') {
    return this.auditLog.log({ actorId: caller.id, action: 'ACCOUNT_DATA_EXPORT', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: id, details: { category }, outcome });
  }

  async download(caller: Caller, id: string) {
    const rec = await this.prisma.ccExport.findFirst({ where: { id, organizationId: caller.organizationId } });
    if (!rec || rec.status !== 'COMPLETED' || !rec.fileKey) throw new NotFoundException('Export not found.');
    if (!rec.expiresAt || rec.expiresAt < new Date()) {
      await this.prisma.ccExport.update({ where: { id }, data: { status: 'EXPIRED' } });
      throw new NotFoundException('This export has expired. Create a new one.');
    }
    const buffer = await readStoredFile(rec.fileKey);
    if (!buffer) throw new NotFoundException('The file is no longer available. Create a new export.');
    await this.prisma.ccExport.update({ where: { id }, data: { downloadCount: { increment: 1 } } });
    await this.auditLog.log({ actorId: caller.id, action: 'ACCOUNT_DATA_EXPORT_DOWNLOADED', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: id, details: { category: rec.category } });
    return { buffer, fileName: rec.fileName ?? 'export', contentType: rec.format === 'CSV' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  // ---------- generators (each filtered by organizationId, capped at ROW_CAP + 1 to detect overflow) ----------
  private async generate(organizationId: string, key: string, from?: string, to?: string): Promise<Table> {
    const take = EXPORT_ROW_CAP + 1;
    const dateWhere = from || to ? { gte: from ?? '0000-00-00', lte: to ?? '9999-12-31' } : undefined;
    switch (key) {
      case 'EMPLOYEES': {
        const rows = await this.prisma.user.findMany({ where: { organizationId }, include: { department: { select: { name: true } } }, orderBy: { employeeId: 'asc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('email', 'Email', 28), col('role', 'Role'), col('department', 'Department'), col('designation', 'Designation'), col('joiningDate', 'Joining date'), col('active', 'Active')],
          rows: rows.map((u) => ({ employeeId: u.employeeId, name: u.name, email: u.email, role: u.role, department: u.department?.name ?? '', designation: u.designation, joiningDate: d(u.joiningDate), active: u.isActive ? 'Yes' : 'No' })),
        };
      }
      case 'ATTENDANCE': {
        const rows = await this.prisma.attendance.findMany({ where: { organizationId, ...(dateWhere ? { date: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: [{ date: 'desc' }], take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('date', 'Date'), col('status', 'Status'), col('inTime', 'In'), col('outTime', 'Out'), col('minutes', 'Worked (min)'), col('late', 'Late')],
          rows: rows.map((a) => ({ employeeId: a.employee.employeeId, name: a.employee.name, date: a.date, status: a.status, inTime: a.inTime?.toISOString() ?? '', outTime: a.outTime?.toISOString() ?? '', minutes: a.workDurationMinutes, late: a.isLate ? 'Yes' : 'No' })),
        };
      }
      case 'LEAVE': {
        const rows = await this.prisma.leave.findMany({ where: { organizationId, ...(dateWhere ? { startDate: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } }, leaveType: { select: { name: true } } }, orderBy: { startDate: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('type', 'Leave type'), col('start', 'From'), col('end', 'To'), col('days', 'Days'), col('status', 'Status'), col('remarks', 'Remarks', 30)],
          rows: rows.map((l) => ({ employeeId: l.employee.employeeId, name: l.employee.name, type: l.leaveType.name, start: l.startDate, end: l.endDate, days: l.totalDays, status: l.status, remarks: l.remarks })),
        };
      }
      case 'PAYROLL': {
        const rows = await this.prisma.payrollRun.findMany({ where: { organizationId }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: [{ year: 'desc' }, { month: 'desc' }], take });
        const inRange = rows.filter((r) => {
          const p = `${r.year}-${String(r.month).padStart(2, '0')}`;
          return (!from || p >= from.slice(0, 7)) && (!to || p <= to.slice(0, 7));
        });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('period', 'Month'), col('status', 'Status'), col('gross', 'Gross'), col('deductions', 'Deductions'), col('net', 'Net pay')],
          rows: inRange.map((r) => ({ employeeId: r.employee.employeeId, name: r.employee.name, period: `${r.year}-${String(r.month).padStart(2, '0')}`, status: r.status, gross: r.grossSalary, deductions: r.totalDeductions, net: r.netPay })),
        };
      }
      case 'SALARY_COMPONENTS': {
        const rows = await this.prisma.salaryComponent.findMany({ where: { organizationId }, orderBy: { displayOrder: 'asc' }, take });
        return {
          columns: [col('name', 'Name'), col('code', 'Code'), col('type', 'Type'), col('calcType', 'Calculation'), col('defaultValue', 'Default value'), col('taxable', 'Taxable')],
          rows: rows.map((c) => ({ name: c.name, code: c.code, type: c.type, calcType: c.calcType, defaultValue: c.defaultValue, taxable: c.isTaxable ? 'Yes' : 'No' })),
        };
      }
      case 'LOANS': {
        const rows = await this.prisma.loan.findMany({ where: { organizationId }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { createdAt: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('type', 'Type'), col('principal', 'Principal'), col('emi', 'EMI'), col('tenure', 'Tenure (months)'), col('outstanding', 'Outstanding'), col('status', 'Status')],
          rows: rows.map((l) => ({ employeeId: l.employee.employeeId, name: l.employee.name, type: l.loanType, principal: l.principal, emi: l.emiAmount, tenure: l.tenureMonths, outstanding: l.outstandingBalance, status: l.status })),
        };
      }
      case 'REIMBURSEMENTS': {
        const rows = await this.prisma.reimbursement.findMany({ where: { organizationId, ...(dateWhere ? { claimDate: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { claimDate: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('category', 'Category'), col('amount', 'Amount'), col('claimDate', 'Claim date'), col('status', 'Status'), col('description', 'Description', 30)],
          rows: rows.map((r) => ({ employeeId: r.employee.employeeId, name: r.employee.name, category: r.category, amount: r.amount, claimDate: r.claimDate, status: r.status, description: r.description })),
        };
      }
      case 'DOCUMENTS': {
        // Document details only (never the files themselves).
        const rows = await this.prisma.employeeDocument.findMany({ where: { organizationId }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { uploadedAt: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('docType', 'Document type'), col('fileName', 'File name', 28), col('category', 'Category'), col('status', 'Status'), col('uploadedAt', 'Uploaded')],
          rows: rows.map((x) => ({ employeeId: x.employee.employeeId, name: x.employee.name, docType: x.docType, fileName: x.fileName, category: x.category, status: x.status, uploadedAt: d(x.uploadedAt) })),
        };
      }
      default:
        throw new BadRequestException('Unknown category.');
    }
  }
}

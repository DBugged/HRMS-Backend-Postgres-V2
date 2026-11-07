// Purpose: the Company Admin's Data Export: builds a spreadsheet/CSV of one data category for the admin's OWN organisation, keeps
//   a history of exports, and serves each file for 24 hours.
// Important: organizationId always comes from the signed-in user. Each export is capped (EXPORT_ROW_CAP rows); the file is stored
//   under the organisation's own folder and the download re-checks tenant, requester role (controller) and expiry.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import ExcelJS from 'exceljs';
import { buildWorkbook, sanitizeSpreadsheetValue } from '../reports/report-export';
import type { ReportColumn } from '../reports/report-export';
import { readStoredFile, writeStoredFile } from '../files/file-storage.config';
import { EXPORT_ALL, EXPORT_CATEGORIES, EXPORT_CATEGORIES_WITH_ALL, EXPORT_LINK_HOURS, EXPORT_ROW_CAP } from './account-logic';

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
    private readonly notifications: NotificationsService,
  ) {}

  categories() {
    return EXPORT_CATEGORIES_WITH_ALL.map((c) => ({ key: c.key, label: c.label, dateRange: c.dateRange }));
  }

  async history(organizationId: string) {
    // A job lost to a server restart would stay "processing" for ever: after 15 minutes it is marked failed.
    await this.prisma.ccExport.updateMany({ where: { organizationId, status: 'PROCESSING', createdAt: { lt: new Date(Date.now() - 15 * 60_000) } }, data: { status: 'FAILED', error: 'The export was interrupted. Please create it again.' } });
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

  /** Starts an export and returns at once; the file is built in the background and the requester is notified when it is ready. */
  async create(caller: Caller, dto: { category: string; format?: string; from?: string; to?: string }, opts: { wait?: boolean; silent?: boolean } = {}) {
    const cat = EXPORT_CATEGORIES_WITH_ALL.find((c) => c.key === dto.category);
    if (!cat) throw new BadRequestException('Choose a data category to export.');
    const isAll = cat.key === EXPORT_ALL;
    // One workbook with a sheet per category cannot be a CSV.
    const format = !isAll && dto.format === 'CSV' ? 'CSV' : 'XLSX';
    if (cat.dateRange) {
      for (const v of [dto.from, dto.to]) if (v && !MONTH_RE.test(v)) throw new BadRequestException('Dates must be YYYY-MM-DD.');
      if (dto.from && dto.to && dto.from > dto.to) throw new BadRequestException('The start date is after the end date.');
    }
    const filters = cat.dateRange ? { from: dto.from ?? null, to: dto.to ?? null } : {};
    const record = await this.prisma.ccExport.create({
      data: { organizationId: caller.organizationId, category: cat.key, format, filters, status: 'PROCESSING', requestedById: caller.id, requestedByName: caller.name },
    });
    const job = this.run(caller, record.id, cat, format, isAll, dto.from, dto.to, opts.silent);
    if (opts.wait) await job;
    return { id: record.id, status: 'PROCESSING' };
  }

  private async run(caller: Caller, id: string, cat: { key: string; label: string }, format: string, isAll: boolean, from?: string, to?: string, silent = false) {
    const organizationId = caller.organizationId;
    const done = (title: string, message: string) =>
      silent ? Promise.resolve() : this.notifications.create({ organizationId, userId: caller.id, title, message, category: 'GENERAL', link: '/account-export' }).catch(() => undefined);
    try {
      let wb: ExcelJS.Workbook;
      let rowCount: number;
      if (isAll) {
        wb = new ExcelJS.Workbook();
        rowCount = 0;
        for (const c of EXPORT_CATEGORIES) {
          const t = await this.generate(organizationId, c.key, from, to);
          if (t.rows.length > EXPORT_ROW_CAP) throw new BadRequestException(`${c.label} has more than ${EXPORT_ROW_CAP} rows. Narrow the date range or export it on its own.`);
          rowCount += t.rows.length;
          const sheet = wb.addWorksheet(c.label.slice(0, 31));
          sheet.columns = t.columns.map((col) => ({ key: col.key, width: col.width }));
          const head = sheet.addRow(t.columns.map((col) => col.header));
          head.font = { bold: true };
          sheet.views = [{ state: 'frozen', ySplit: 1 }];
          for (const r of t.rows) sheet.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sanitizeSpreadsheetValue(v)])));
        }
      } else {
        const table = await this.generate(organizationId, cat.key, from, to);
        if (table.rows.length > EXPORT_ROW_CAP) throw new BadRequestException(`This export has more than ${EXPORT_ROW_CAP} rows. Narrow the date range.`);
        wb = buildWorkbook(cat.label, table.columns, table.rows, undefined, null, { styled: format === 'XLSX' });
        rowCount = table.rows.length;
      }
      const buffer = Buffer.from(format === 'CSV' ? await wb.csv.writeBuffer() : await wb.xlsx.writeBuffer());
      const fileName = `${isAll ? 'all-data' : cat.key.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
      const fileKey = `${organizationId}/account-exports/${id}-${fileName}`;
      await writeStoredFile(fileKey, buffer, format === 'CSV' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await this.prisma.ccExport.update({
        where: { id },
        data: { status: 'COMPLETED', fileKey, fileName, rowCount, completedAt: new Date(), expiresAt: new Date(Date.now() + EXPORT_LINK_HOURS * 3600_000) },
      });
      await this.audit(caller, id, cat.key, 'SUCCESS');
      await done('Your data export is ready', `${cat.label} (${rowCount} rows) is ready to download for the next ${EXPORT_LINK_HOURS} hours.`);
    } catch (e) {
      const msg = e instanceof BadRequestException ? e.message : 'The export could not be generated.';
      await this.prisma.ccExport.update({ where: { id }, data: { status: 'FAILED', error: msg } }).catch(() => undefined);
      await this.audit(caller, id, cat.key, 'FAILURE');
      await done('Your data export failed', `${cat.label}: ${msg}`);
    }
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
      case 'LEAVE_BALANCES': {
        const rows = await this.prisma.leaveBalance.findMany({ where: { organizationId }, include: { employee: { select: { employeeId: true, name: true } }, leaveType: { select: { name: true } } }, orderBy: [{ year: 'desc' }], take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('type', 'Leave type'), col('year', 'Year', 8), col('opening', 'Opening', 10), col('credited', 'Credited', 10), col('availed', 'Availed', 10), col('pending', 'Pending', 10), col('encashed', 'Encashed', 10), col('adjusted', 'Adjusted', 10), col('closing', 'Balance', 10)],
          rows: rows.map((b) => ({ employeeId: b.employee.employeeId, name: b.employee.name, type: b.leaveType.name, year: b.year, opening: b.opening, credited: b.credited, availed: b.availed, pending: b.pending, encashed: b.encashed, adjusted: b.adjusted, closing: b.closing })),
        };
      }
      case 'DEPARTMENTS': {
        const rows = await this.prisma.department.findMany({ where: { organizationId }, include: { workLocation: { select: { name: true } } }, orderBy: { name: 'asc' }, take });
        const heads = await this.prisma.user.findMany({ where: { organizationId, id: { in: rows.map((r) => r.departmentHeadId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
        const headName = new Map(heads.map((h) => [h.id, h.name]));
        return {
          columns: [col('name', 'Department'), col('code', 'Code', 12), col('head', 'Head'), col('location', 'Location'), col('shift', 'Shift'), col('active', 'Active', 10), col('description', 'Description', 30)],
          rows: rows.map((x) => ({ name: x.name, code: x.code, head: x.departmentHeadId ? headName.get(x.departmentHeadId) ?? '' : '', location: x.workLocation?.name ?? '', shift: `${x.shiftStartTime} - ${x.shiftEndTime}`, active: x.isActive ? 'Yes' : 'No', description: x.description })),
        };
      }
      case 'LOCATIONS': {
        const rows = await this.prisma.workLocation.findMany({ where: { organizationId }, orderBy: { name: 'asc' }, take });
        return {
          columns: [col('name', 'Name'), col('address', 'Address', 32), col('city', 'City'), col('state', 'State'), col('radius', 'Geo-fence radius (m)', 20), col('active', 'Active', 10)],
          rows: rows.map((x) => ({ name: x.name, address: x.address, city: x.city, state: x.state, radius: x.radiusMeters, active: x.isActive ? 'Yes' : 'No' })),
        };
      }
      case 'HOLIDAYS': {
        const rows = await this.prisma.holiday.findMany({ where: { organizationId, isReference: false, ...(dateWhere ? { date: dateWhere } : {}) }, include: { department: { select: { name: true } } }, orderBy: { date: 'asc' }, take });
        return {
          columns: [col('date', 'Date'), col('name', 'Holiday', 28), col('type', 'Type'), col('optional', 'Optional', 10), col('department', 'Department'), col('state', 'State'), col('active', 'Active', 10)],
          rows: rows.map((h) => ({ date: h.date, name: h.name, type: h.type, optional: h.isOptional ? 'Yes' : 'No', department: h.department?.name ?? 'All', state: h.state ?? '', active: h.isActive ? 'Yes' : 'No' })),
        };
      }
      case 'ASSETS': {
        const rows = await this.prisma.asset.findMany({ where: { organizationId }, orderBy: { assetCode: 'asc' }, take });
        return {
          columns: [col('code', 'Asset code'), col('name', 'Asset name', 26), col('brand', 'Brand'), col('model', 'Model'), col('serial', 'Serial number'), col('purchaseDate', 'Purchase date'), col('cost', 'Purchase cost'), col('location', 'Location'), col('condition', 'Condition'), col('status', 'Status')],
          rows: rows.map((a) => ({ code: a.assetCode, name: a.assetName, brand: a.brand ?? '', model: a.model ?? '', serial: a.serialNumber ?? '', purchaseDate: d(a.purchaseDate), cost: a.purchaseCost ?? '', location: a.location ?? '', condition: a.condition, status: a.status })),
        };
      }
      case 'ASSET_ALLOCATIONS': {
        const rows = await this.prisma.employeeAsset.findMany({ where: { organizationId }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { allocatedDate: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('asset', 'Asset', 26), col('type', 'Type'), col('tag', 'Asset tag'), col('allocated', 'Allocated on'), col('returned', 'Returned on'), col('status', 'Status')],
          rows: rows.map((a) => ({ employeeId: a.employee.employeeId, name: a.employee.name, asset: a.assetName, type: a.assetType, tag: a.assetTag ?? '', allocated: a.allocatedDate, returned: a.returnedDate ?? '', status: a.status })),
        };
      }
      case 'RESIGNATIONS': {
        const rows = await this.prisma.resignation.findMany({ where: { organizationId, ...(dateWhere ? { submittedOn: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { submittedOn: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('submitted', 'Submitted on'), col('requestedLwd', 'Requested last day'), col('approvedLwd', 'Approved last day'), col('notice', 'Notice (days)'), col('reason', 'Reason', 30), col('status', 'Status')],
          rows: rows.map((r) => ({ employeeId: r.employee.employeeId, name: r.employee.name, submitted: r.submittedOn, requestedLwd: r.requestedLwd, approvedLwd: r.approvedLwd ?? '', notice: r.noticePeriodDays ?? '', reason: r.reason ?? '', status: r.status })),
        };
      }
      case 'SETTLEMENTS': {
        const rows = await this.prisma.settlement.findMany({ where: { organizationId, ...(dateWhere ? { lastWorkingDay: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { lastWorkingDay: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('lwd', 'Last working day'), col('salary', 'Pending salary'), col('leave', 'Leave encashment'), col('gratuity', 'Gratuity'), col('recoveries', 'Recoveries'), col('net', 'Net settlement'), col('status', 'Status')],
          rows: rows.map((s) => ({ employeeId: s.employee.employeeId, name: s.employee.name, lwd: s.lastWorkingDay, salary: s.pendingSalaryAmount, leave: s.leaveEncashmentAmount, gratuity: s.gratuityAmount, recoveries: s.recoveriesAmount, net: s.netSettlementAmount, status: s.status })),
        };
      }
      case 'OVERTIME': {
        const rows = await this.prisma.overtimeRecord.findMany({ where: { organizationId, ...(dateWhere ? { date: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { date: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('date', 'Date'), col('hours', 'Hours', 10), col('type', 'Type'), col('multiplier', 'Rate multiplier', 16), col('status', 'Status')],
          rows: rows.map((o) => ({ employeeId: o.employee.employeeId, name: o.employee.name, date: o.date, hours: o.hours, type: o.type, multiplier: o.rateMultiplier, status: o.status })),
        };
      }
      case 'COMP_OFFS': {
        const rows = await this.prisma.compOff.findMany({ where: { organizationId, ...(dateWhere ? { earnedForDate: dateWhere } : {}) }, include: { employee: { select: { employeeId: true, name: true } } }, orderBy: { earnedForDate: 'desc' }, take });
        return {
          columns: [col('employeeId', 'Employee ID'), col('name', 'Name'), col('earned', 'Earned for'), col('days', 'Days earned', 12), col('availed', 'Days availed', 12), col('expiry', 'Expires'), col('status', 'Status'), col('reason', 'Reason', 28)],
          rows: rows.map((c) => ({ employeeId: c.employee.employeeId, name: c.employee.name, earned: c.earnedForDate, days: c.daysEarned, availed: c.daysAvailed, expiry: c.expiryDate ?? '', status: c.status, reason: c.reason })),
        };
      }
      default:
        throw new BadRequestException('Unknown category.');
    }
  }
}

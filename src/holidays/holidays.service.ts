// Purpose: Manages the org's holiday calendar — CRUD, national-holiday seeding (available but not wired
// into registration — see AuthService.register()), and spreadsheet bulk import.
// Responsibilities: Owns duplicate detection (same name+date) and bulkImport()'s per-row fail-but-continue
// validation; seedDefaults() pre-populates the current year's 3 fixed National Holidays but is not called
// automatically — the Holiday Calendar starts empty for a new org, same as any other admin-managed list.
// Important: bulkImport() mirrors the old bulkImportHolidays' behavior exactly — invalid or duplicate rows
// are collected into `failed` rather than aborting the whole batch, and duplicates are checked both against
// existing DB rows and within the same batch.
import { AttendanceService } from '../attendance/attendance.service';
import { calendarStatus } from './holiday-calendar-status';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Holiday, HolidayType, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto';
import { BulkImportHolidaysDto } from './dto/bulk-import-holidays.dto';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';
import { todayInOrgTz } from '../common/org-date';

const VALID_TYPES = new Set(Object.values(HolidayType));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Bulk-import rows are untyped, client-parsed spreadsheet cells — this
// coerces only actual strings/numbers/booleans (the values a spreadsheet
// cell can realistically hold) rather than blindly calling String() on an
// arbitrary unknown, which could stringify to "[object Object]".
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

@Injectable()
export class HolidaysService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly attendanceService: AttendanceService,
  ) {}

  // After a holiday changes, the attendance already written for its date(s) follows the new calendar. A locked or paid
  // payroll month is not rewritten: `warning` names who was left as they were, for the screen to show.
  private async recalculateAttendance(
    organizationId: string,
    dates: string[],
    departmentIds: (string | null)[],
  ) {
    const { updated, locked } =
      await this.attendanceService.recalculateForHolidayChange(
        organizationId,
        dates,
        departmentIds,
      );
    const names = [...new Set(locked.map((l) => l.name))];
    return {
      updated,
      lockedCount: locked.length,
      warning: names.length
        ? `Attendance was not changed for ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}: payroll for that month is already locked or paid. Unlock the payroll run first if their attendance should follow the new holiday calendar.`
        : null,
    };
  }

  private async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  // India's 3 fixed National Holidays (Republic Day, Independence Day,
  // Gandhi Jayanti) — same date every year, mandated for every
  // establishment, distinct from festival/restricted holidays which shift
  // by year and region. NOT called from AuthService.register() — unlike
  // LeaveTypesService/SalaryComponentsService.seedDefaults, these aren't a
  // neutral default (only apply to Indian establishments), so the Holiday
  // Calendar starts empty for a new org and admins add their own. Kept
  // here for any caller that does want it; fully editable/deletable
  // afterward like any other holiday — nothing marks these as
  // special/immutable.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
    year: number = new Date().getFullYear(),
  ): Promise<void> {
    const NATIONAL_HOLIDAYS = [
      { name: 'Republic Day', month: 1, day: 26 },
      { name: 'Independence Day', month: 8, day: 15 },
      { name: 'Gandhi Jayanti', month: 10, day: 2 },
    ];
    for (const h of NATIONAL_HOLIDAYS) {
      const date = `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`;
      await tx.holiday.create({
        data: {
          organizationId,
          name: h.name,
          date,
          year,
          departmentId: null,
          type: HolidayType.NATIONAL,
          isOptional: false,
          description: 'National Holiday',
        },
      });
    }
  }

  /**
   * Next year's holiday count against this year's, so HR can be asked to add the coming year's calendar (see
   * holiday-calendar-status.ts). Counts what attendance would actually honour: active holidays and reference holidays.
   */
  async calendarStatus(organizationId: string) {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const year = Number(today.slice(0, 4));
    const count = (y: number) =>
      this.scopedPrisma.holiday.count({ where: { organizationId, year: y, OR: [{ isActive: true }, { isReference: true }] } });
    const [thisYear, nextYear] = await Promise.all([count(year), count(year + 1)]);
    return calendarStatus(today, nextYear, thisYear);
  }

  /** Every year that has at least one holiday, plus this year and next, oldest first: the Holiday Calendar's year picker. */
  async years(organizationId: string): Promise<number[]> {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const year = Number(today.slice(0, 4));
    const rows = await this.scopedPrisma.holiday.groupBy({ by: ['year'], where: { organizationId }, _count: { _all: true } });
    return [...new Set([...rows.map((r) => r.year), year, year + 1])].sort((a, b) => a - b);
  }

  // The company's weekly off days (0 = Sunday ... 6 = Saturday), so the calendar can say when a holiday falls on one.
  async weeklyOffs(organizationId: string): Promise<number[]> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { orgPayrollAttendancePrefs: true },
    });
    const days = (org?.orgPayrollAttendancePrefs as { weekendDays?: unknown } | null)?.weekendDays;
    const list = Array.isArray(days) ? days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    return list.length > 0 ? list : [0];
  }

  // Copies one year's holidays into another on the same day and month (e.g. 26-01-2026 -> 26-01-2027), for HR to adjust: fixed-date
  // holidays are right, movable festivals need their new dates. Skips a day that has passed, 29 February in a non-leap year, and
  // anything already there with the same name and date.
  async copyYear(fromYear: number, toYear: number, organizationId: string, actorId?: string) {
    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear === toYear) {
      throw new BadRequestException('Pick two different years.');
    }
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const source = await this.scopedPrisma.holiday.findMany({ where: { organizationId, year: fromYear } });
    let created = 0;
    let skipped = 0;
    for (const h of source) {
      const date = `${toYear}${h.date.slice(4)}`;
      const valid = !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
      const exists = valid && (await this.scopedPrisma.holiday.findFirst({ where: { organizationId, date, name: h.name } }));
      if (!valid || date < today || exists) { skipped++; continue; }
      await this.scopedPrisma.holiday.create({
        data: { organizationId, name: h.name, date, departmentId: h.departmentId, year: toYear, isOptional: h.isOptional, type: h.type, state: h.state, description: h.description, isActive: h.isActive },
      });
      created++;
    }
    if (actorId) {
      await this.auditLogService.log({ actorId, action: 'HOLIDAYS_COPIED', module: 'HOLIDAY', organizationId, details: { fromYear, toYear, created, skipped } });
    }
    return { created, skipped };
  }

  async create(
    dto: CreateHolidayDto,
    organizationId: string,
    actorId?: string,
  ) {
    const name = dto.name.trim();
    // From the date text itself: reading it through a Date and its local year gives the wrong year on a server west of UTC.
    const year = Number(dto.date.slice(0, 4));

    // A holiday may be added for a date that has passed: the attendance already written for that day is recalculated
    // below (a locked or paid payroll month is left as it is, with a warning).
    await this.assertDepartmentInOrg(dto.department, organizationId);
    await this.assertNoDuplicate(organizationId, dto.date, name);

    const holiday = await this.scopedPrisma.holiday.create({
      data: {
        organizationId,
        name,
        date: dto.date,
        departmentId: dto.department ?? null,
        year,
        isOptional: dto.isOptional ?? false,
        type: dto.type ?? HolidayType.COMPANY,
        state: dto.state ?? null,
        description: dto.description ?? '',
        isActive: dto.isActive ?? true,
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'HOLIDAY_CREATED',
        module: 'HOLIDAY',
        organizationId,
        targetId: holiday.id,
        details: { name: holiday.name, date: holiday.date },
      });
    }

    const attendance = holiday.isActive
      ? await this.recalculateAttendance(organizationId, [holiday.date], [holiday.departmentId])
      : null;
    return { ...holiday, attendance };
  }

  async findAll(query: ListHolidaysQueryDto, organizationId: string) {
    const data = await this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        ...(query.year && { year: query.year }),
        ...(query.department && {
          OR: [{ departmentId: query.department }, { departmentId: null }],
        }),
        ...(query.type && { type: query.type }),
      },
      include: {
        department: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });
    return wrapAll(data);
  }

  async update(
    id: string,
    dto: UpdateHolidayDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);

    // A past holiday may be edited too: the attendance of its old and new date is recalculated below (a locked or paid
    // payroll month is left as it is, with a warning).
    await this.assertDepartmentInOrg(dto.department, organizationId);
    const nextName = (dto.name ?? existing.name).trim();
    const nextDate = dto.date ?? existing.date;
    await this.assertNoDuplicate(organizationId, nextDate, nextName, id);

    await this.scopedPrisma.holiday.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: nextName }),
        ...(dto.date !== undefined && {
          date: dto.date,
          year: Number(dto.date.slice(0, 4)),
        }),
        ...(dto.department !== undefined && { departmentId: dto.department }),
        ...(dto.isOptional !== undefined && { isOptional: dto.isOptional }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.state !== undefined && { state: dto.state }),
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'HOLIDAY_UPDATED',
        module: 'HOLIDAY',
        organizationId,
        targetId: id,
      });
    }

    const after = await this.findByIdOrThrow(id, organizationId);
    const calendarChanged =
      after.date !== existing.date ||
      after.departmentId !== existing.departmentId ||
      after.isActive !== existing.isActive;
    const attendance = calendarChanged
      ? await this.recalculateAttendance(
          organizationId,
          [existing.date, after.date],
          [existing.departmentId, after.departmentId],
        )
      : null;
    return { ...after, attendance };
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    // A past holiday may be deleted too: the attendance of that date is recalculated below (a locked or paid payroll
    // month is left as it is, with a warning).
    await this.scopedPrisma.holiday.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'HOLIDAY_DELETED',
        module: 'HOLIDAY',
        organizationId,
        targetId: id,
        details: { name: existing.name, date: existing.date },
      });
    }

    const attendance = await this.recalculateAttendance(
      organizationId,
      [existing.date],
      [existing.departmentId],
    );
    return { message: 'Holiday deleted', attendance };
  }

  // Mirrors the old bulkImportHolidays' fail-but-continue behavior exactly:
  // each row is validated independently, invalid/duplicate rows are
  // collected into `failed` rather than aborting the whole batch, and only
  // the valid remainder is actually created.
  async bulkImport(
    dto: BulkImportHolidaysDto,
    organizationId: string,
    actorId?: string,
  ) {
    const failed: {
      row: number;
      name: string;
      date: unknown;
      error: string;
    }[] = [];
    const toCreate: {
      organizationId: string;
      name: string;
      date: string;
      year: number;
      type: HolidayType;
      description: string;
      isOptional: boolean;
      departmentId: null;
      // false for a date that has already passed: kept as a reference record only (see below).
      isActive: boolean;
      isReference: boolean;
    }[] = [];
    const seenInBatch = new Set<string>();

    const years = [
      ...new Set(
        dto.rows
          .map((r) => {
            const d = asString(r.date).trim();
            return DATE_RE.test(d) ? Number(d.slice(0, 4)) : null;
          })
          .filter((y): y is number => y !== null),
      ),
    ];

    const existing = years.length
      ? await this.scopedPrisma.holiday.findMany({
          where: { organizationId, year: { in: years } },
          select: { name: true, date: true },
        })
      : [];
    const existingKeys = new Set(
      existing.map((h) => `${h.date}|${h.name.trim().toLowerCase()}`),
    );
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));

    dto.rows.forEach((row, i) => {
      const rowNum = (row.rowNum as number) || i + 2;
      const name = asString(row.name).trim();
      const date = asString(row.date).trim();
      const typeRaw = asString(row.type).trim().toLowerCase();
      const description = asString(row.description).trim();

      if (!name) {
        failed.push({
          row: rowNum,
          name,
          date,
          error: 'Holiday Name is required',
        });
        return;
      }
      if (
        !date ||
        !DATE_RE.test(date) ||
        Number.isNaN(new Date(date).getTime())
      ) {
        failed.push({
          row: rowNum,
          name,
          date: row.date,
          error: 'Invalid or missing Holiday Date (expected DD-MM-YYYY)',
        });
        return;
      }

      // A date that has already passed is still accepted, so a whole-year calendar loads in one go, but it is saved as
      // an INACTIVE reference record. Attendance, leave, overtime and payroll all read only active holidays, so
      // it never changes anything already calculated; and a past holiday stays read-only (cannot be edited, activated or
      // deleted afterwards) like every other past one.
      const isPast = date < today;

      const type = VALID_TYPES.has(typeRaw.toUpperCase() as HolidayType)
        ? (typeRaw.toUpperCase() as HolidayType)
        : HolidayType.COMPANY;

      const key = `${date}|${name.toLowerCase()}`;
      if (existingKeys.has(key) || seenInBatch.has(key)) {
        failed.push({
          row: rowNum,
          name,
          date,
          error: 'Duplicate holiday (same name and date already exist)',
        });
        return;
      }
      seenInBatch.add(key);
      toCreate.push({
        organizationId,
        name,
        date,
        year: Number(date.slice(0, 4)),
        type,
        description,
        isOptional: type === HolidayType.OPTIONAL,
        departmentId: null,
        isActive: !isPast,
        isReference: isPast,
      });
    });

    const created = toCreate.length
      ? await this.scopedPrisma.holiday.createMany({ data: toCreate })
      : { count: 0 };

    if (actorId && created.count > 0) {
      await this.auditLogService.log({
        actorId,
        action: 'HOLIDAY_BULK_IMPORTED',
        module: 'HOLIDAY',
        organizationId,
        details: {
          created: created.count,
          failed: failed.length,
          pastReferenceOnly: toCreate.filter((h) => !h.isActive).length,
        },
      });
    }

    // `pastReferenceOnly`: how many of the created rows were already in the past (saved as reference records).
    return {
      created: created.count,
      pastReferenceOnly: toCreate.filter((h) => !h.isActive).length,
      failed,
    };
  }

  // A department-specific holiday must name a department of this organisation.
  private async assertDepartmentInOrg(departmentId: string | null | undefined, organizationId: string) {
    if (!departmentId) return;
    const dept = await this.scopedPrisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });
    if (!dept) throw new BadRequestException('The selected department was not found.');
  }

  private async assertNoDuplicate(
    organizationId: string,
    date: string,
    name: string,
    excludeId?: string,
  ) {
    const duplicate = await this.scopedPrisma.holiday.findFirst({
      where: {
        organizationId,
        date,
        name,
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
    if (duplicate) {
      throw new ConflictException(
        'A holiday with this name and date already exists.',
      );
    }
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<Holiday> {
    const holiday = await this.scopedPrisma.holiday.findFirst({
      where: { id, organizationId },
    });
    if (!holiday) throw new NotFoundException('Holiday not found.');
    return holiday;
  }
}

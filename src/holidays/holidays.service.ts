// Purpose: Manages the org's holiday calendar — CRUD, registration-time national-holiday seeding, and
// spreadsheet bulk import.
// Responsibilities: Owns duplicate detection (same name+date) and bulkImport()'s per-row fail-but-continue
// validation; seedDefaults() is called once from AuthService.register() to pre-populate the current year's
// 3 fixed National Holidays.
// Important: bulkImport() mirrors the old bulkImportHolidays' behavior exactly — invalid or duplicate rows
// are collected into `failed` rather than aborting the whole batch, and duplicates are checked both against
// existing DB rows and within the same batch.
import {
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
  ) {}

  // India's 3 fixed National Holidays (Republic Day, Independence Day,
  // Gandhi Jayanti) — same date every year, mandated for every
  // establishment, distinct from festival/restricted holidays which shift
  // by year and region. Seeded for the current year so the Holiday
  // Calendar isn't empty on day one; fully editable/deletable afterward
  // like any other holiday — nothing marks these as special/immutable.
  // Same registration-time integration point as LeaveTypesService/
  // SalaryComponentsService.seedDefaults.
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

  async create(
    dto: CreateHolidayDto,
    organizationId: string,
    actorId?: string,
  ) {
    const name = dto.name.trim();
    const year = new Date(dto.date).getFullYear();

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

    return holiday;
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

    const nextName = (dto.name ?? existing.name).trim();
    const nextDate = dto.date ?? existing.date;
    await this.assertNoDuplicate(organizationId, nextDate, nextName, id);

    await this.scopedPrisma.holiday.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: nextName }),
        ...(dto.date !== undefined && {
          date: dto.date,
          year: new Date(dto.date).getFullYear(),
        }),
        ...(dto.department !== undefined && { departmentId: dto.department }),
        ...(dto.isOptional !== undefined && { isOptional: dto.isOptional }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.state !== undefined && { state: dto.state }),
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
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

    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
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

    return { message: 'Holiday deleted' };
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
          error: 'Invalid or missing Holiday Date (expected YYYY-MM-DD)',
        });
        return;
      }

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
        details: { created: created.count, failed: failed.length },
      });
    }

    return { created: created.count, failed };
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

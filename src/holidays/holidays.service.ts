import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Holiday, HolidayType } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto';
import { BulkImportHolidaysDto } from './dto/bulk-import-holidays.dto';

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
  ) {}

  async create(dto: CreateHolidayDto, organizationId: string) {
    const name = dto.name.trim();
    const year = new Date(dto.date).getFullYear();

    await this.assertNoDuplicate(organizationId, dto.date, name);

    return this.scopedPrisma.holiday.create({
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
  }

  async findAll(query: ListHolidaysQueryDto, organizationId: string) {
    return this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        ...(query.year && { year: query.year }),
        ...(query.department && {
          OR: [{ departmentId: query.department }, { departmentId: null }],
        }),
        ...(query.type && { type: query.type }),
      },
      orderBy: { date: 'asc' },
    });
  }

  async update(id: string, dto: UpdateHolidayDto, organizationId: string) {
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

    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.holiday.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Holiday deleted' };
  }

  // Mirrors the old bulkImportHolidays' fail-but-continue behavior exactly:
  // each row is validated independently, invalid/duplicate rows are
  // collected into `failed` rather than aborting the whole batch, and only
  // the valid remainder is actually created.
  async bulkImport(dto: BulkImportHolidaysDto, organizationId: string) {
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

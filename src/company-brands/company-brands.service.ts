// Purpose: manage a company's brands - the sister-company names, logos and employee ID series an Admin adds under Organization.
// Responsibilities: list / create / update / delete brands for one organization, keeping the rules that stop two brands (or a brand and
//   the company itself) from sharing a name or an employee ID prefix, allowing only one default brand, and refusing to delete a brand
//   that people are tagged with (it can be deactivated instead). Every change is audited.
// Important: nothing here changes an existing employee or any existing ID. An employee's brand is set on the employee, and an ID, once
//   issued, never changes with the brand.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, Prisma, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { sisterCompaniesOn } from '../module-access/module-gate';
import { isKeyAllowedForOrg } from '../files/file-token';
import { takenEmployeeIdPrefixes } from '../common/employee-id-prefixes';
import { employeeIdPrefixOf, nextEmployeeId, prefixesClash } from './brand-rules';
import { CreateCompanyBrandDto } from './dto/create-company-brand.dto';
import { UpdateCompanyBrandDto } from './dto/update-company-brand.dto';

type Actor = Omit<User, 'password'>;

const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

@Injectable()
export class CompanyBrandsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(organizationId: string) {
    // Switched off for this company: there is nothing to show, and every brand control stays hidden.
    if (!(await sisterCompaniesOn(organizationId))) return [];
    const brands = await this.scopedPrisma.companyBrand.findMany({
      where: { organizationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } },
    });
    return brands.map(({ _count, ...b }) => ({
      ...b,
      employeeCount: _count.users,
      nextEmployeeId: b.employeeIdFormat ? nextEmployeeId(b.employeeIdFormat, b.employeeIdCounter) : null,
    }));
  }

  async create(dto: CreateCompanyBrandDto, actor: Actor, organizationId: string) {
    await this.assertEnabled(organizationId);
    const name = dto.name.trim();
    await this.assertNameFree(name, organizationId);
    const format = blank(dto.employeeIdFormat);
    if (format) await this.assertSeriesFree(format, organizationId);
    this.assertFileKeys(dto, organizationId);
    const created = await this.scopedPrisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.companyBrand.updateMany({ where: { organizationId, isDefault: true }, data: { isDefault: false } });
      return tx.companyBrand.create({
        data: {
          organizationId,
          name,
          legalName: blank(dto.legalName),
          logoUrl: blank(dto.logoUrl),
          emailLogoUrl: blank(dto.emailLogoUrl),
          address: blank(dto.address),
          contactEmail: blank(dto.contactEmail),
          phone: blank(dto.phone),
          website: blank(dto.website),
          employeeIdFormat: format,
          // The counter holds the last number issued, so the series starts at the chosen number.
          employeeIdCounter: format ? Math.max(0, (dto.employeeIdStart ?? 1) - 1) : 0,
          isDefault: !!dto.isDefault,
        },
      });
    });
    await this.audit(actor, 'COMPANY_BRAND_CREATED', created.id, organizationId, { name });
    return created;
  }

  async update(id: string, dto: UpdateCompanyBrandDto, actor: Actor, organizationId: string) {
    await this.assertEnabled(organizationId);
    const brand = await this.findOrThrow(id, organizationId);
    const data: Prisma.CompanyBrandUpdateInput = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.toLowerCase() !== brand.name.toLowerCase()) await this.assertNameFree(name, organizationId, id);
      data.name = name;
    }
    for (const key of ['legalName', 'logoUrl', 'emailLogoUrl', 'address', 'contactEmail', 'phone', 'website'] as const) {
      if (dto[key] !== undefined) data[key] = blank(dto[key]);
    }
    this.assertFileKeys(dto, organizationId);
    if (dto.employeeIdFormat !== undefined) {
      const format = blank(dto.employeeIdFormat);
      if (format && format !== brand.employeeIdFormat) await this.assertSeriesFree(format, organizationId, id);
      data.employeeIdFormat = format;
      // Switching a series on starts it at the chosen number; a series already running keeps its counter.
      if (format && !brand.employeeIdFormat) data.employeeIdCounter = Math.max(0, (dto.employeeIdStart ?? 1) - 1);
    }
    const willBeActive = dto.isActive ?? brand.isActive;
    if (dto.isDefault && !willBeActive) throw new BadRequestException('An inactive brand cannot be the default.');
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    // Deactivating the default brand stops it being the default.
    if (dto.isDefault !== undefined) data.isDefault = dto.isDefault && willBeActive;
    else if (!willBeActive) data.isDefault = false;

    const updated = await this.scopedPrisma.$transaction(async (tx) => {
      if (data.isDefault === true) await tx.companyBrand.updateMany({ where: { organizationId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      await tx.companyBrand.updateMany({ where: { id, organizationId }, data });
      return tx.companyBrand.findFirstOrThrow({ where: { id, organizationId } });
    });
    await this.audit(actor, 'COMPANY_BRAND_UPDATED', id, organizationId, { fields: Object.keys(data) });
    return updated;
  }

  async remove(id: string, actor: Actor, organizationId: string) {
    await this.assertEnabled(organizationId);
    const brand = await this.findOrThrow(id, organizationId);
    const inUse = await this.scopedPrisma.user.count({ where: { organizationId, brandId: id } });
    if (inUse > 0) {
      throw new ConflictException(`${inUse} ${inUse === 1 ? 'employee is' : 'employees are'} tagged with this company. Move them to another first, or deactivate it instead.`);
    }
    await this.scopedPrisma.companyBrand.deleteMany({ where: { id, organizationId } });
    await this.audit(actor, 'COMPANY_BRAND_DELETED', id, organizationId, { name: brand.name });
    return { message: 'Company deleted.' };
  }

  private async assertEnabled(organizationId: string) {
    if (!(await sisterCompaniesOn(organizationId))) {
      throw new ForbiddenException('Sister companies is not switched on for your company. Ask your account manager to enable it.');
    }
  }

  private async findOrThrow(id: string, organizationId: string) {
    const brand = await this.scopedPrisma.companyBrand.findFirst({ where: { id, organizationId } });
    if (!brand) throw new NotFoundException('Company not found.');
    return brand;
  }

  private async assertNameFree(name: string, organizationId: string, exceptId?: string) {
    const same = await this.scopedPrisma.companyBrand.findFirst({
      where: { organizationId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (same) throw new ConflictException('A company with this name already exists.');
  }

  // The ID prefix must not collide with the company's own series or another brand's: an ID is unique across the company.
  private async assertSeriesFree(format: string, organizationId: string, exceptId?: string) {
    const prefix = employeeIdPrefixOf(format);
    const [org, others] = await Promise.all([
      this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { documentNumbering: true } }),
      this.scopedPrisma.companyBrand.findMany({
        where: { organizationId, employeeIdFormat: { not: null }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { name: true, employeeIdFormat: true },
      }),
    ]);
    const orgFormat = (org?.documentNumbering as { employeeId?: { format?: string } } | null)?.employeeId?.format;
    if (prefixesClash(prefix, employeeIdPrefixOf(orgFormat))) {
      throw new ConflictException(`The ID prefix "${prefix}" is already used by the company's own employee IDs. Pick a different prefix.`);
    }
    const clash = others.find((o) => prefixesClash(prefix, employeeIdPrefixOf(o.employeeIdFormat)));
    if (clash) throw new ConflictException(`The ID prefix "${prefix}" is already used by ${clash.name}. Pick a different prefix.`);
    // Also across every other company: an ID prefix is unique everywhere, so employees can sign in with their ID.
    const elsewhere = (await takenEmployeeIdPrefixes(this.scopedPrisma, organizationId)).find((t) => prefixesClash(prefix, t));
    if (elsewhere) throw new ConflictException(`The ID prefix "${prefix}" is already used by another company. Pick a different prefix.`);
  }

  private assertFileKeys(dto: { logoUrl?: string | null; emailLogoUrl?: string | null }, organizationId: string) {
    for (const key of [dto.logoUrl, dto.emailLogoUrl]) {
      if (key && !isKeyAllowedForOrg(organizationId, key)) throw new BadRequestException('Invalid file reference.');
    }
  }

  private audit(actor: Actor, action: string, targetId: string, organizationId: string, details: Record<string, unknown>) {
    return this.auditLogService.log({ actorId: actor.id, action, module: AuditModule.ORGANIZATION, organizationId, targetId, details });
  }
}

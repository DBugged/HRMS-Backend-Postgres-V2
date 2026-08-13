import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

// Organization is not in TENANT_SCOPED_MODELS (it IS the tenant boundary),
// so this uses the plain PrismaService, and every query below is scoped
// explicitly via `where: { id }` derived from the authenticated caller's
// own organizationId — never from a client-supplied value — closing off
// cross-tenant access by construction rather than relying on the
// extension to catch it.
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOwn(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) throw new NotFoundException('Organization not found.');
    return org;
  }

  async updateOwn(organizationId: string, dto: UpdateOrganizationDto) {
    await this.findOwn(organizationId); // 404s before attempting the update if somehow missing
    return this.prisma.organization.update({
      where: { id: organizationId },
      data: dto,
    });
  }
}

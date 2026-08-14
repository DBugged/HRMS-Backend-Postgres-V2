import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FenceType, Prisma, WorkLocation } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateWorkLocationDto } from './dto/create-work-location.dto';
import { UpdateWorkLocationDto } from './dto/update-work-location.dto';
import { ListWorkLocationsQueryDto } from './dto/list-work-locations-query.dto';
import { deriveCircleSummary, isInsideGeoFence } from './geo-fence';
import { validateGeometry } from './geometry-validation';

type Boundary = { bounds?: [number, number][]; vertices?: [number, number][] };

@Injectable()
export class WorkLocationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async create(
    dto: CreateWorkLocationDto,
    createdById: string,
    organizationId: string,
  ) {
    const fenceType = dto.fenceType ?? FenceType.CIRCLE;
    const boundary = dto.boundary;

    this.assertValidGeometry(fenceType, boundary, dto.latitude, dto.longitude);

    const summary = deriveCircleSummary(
      fenceType,
      boundary,
      dto.latitude as number,
      dto.longitude as number,
      dto.radiusMeters ?? 200,
    );

    return this.scopedPrisma.workLocation.create({
      data: {
        organizationId,
        name: dto.name,
        address: dto.address ?? '',
        description: dto.description ?? '',
        fenceType,
        boundary:
          fenceType === FenceType.CIRCLE
            ? Prisma.JsonNull
            : (boundary as Prisma.InputJsonValue),
        latitude: summary.latitude,
        longitude: summary.longitude,
        radiusMeters:
          fenceType === FenceType.CIRCLE
            ? Number(dto.radiusMeters) || 200
            : summary.radiusMeters,
        createdById,
      },
    });
  }

  async findAll(query: ListWorkLocationsQueryDto, organizationId: string) {
    return this.scopedPrisma.workLocation.findMany({
      where: {
        organizationId,
        ...(query.activeOnly && { isActive: true }),
        ...(query.search && {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            {
              address: {
                contains: query.search,
                mode: 'insensitive' as const,
              },
            },
          ],
        }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, organizationId: string) {
    return this.findByIdOrThrow(id, organizationId);
  }

  async checkPoint(
    id: string,
    latitude: number,
    longitude: number,
    organizationId: string,
  ) {
    const location = await this.findByIdOrThrow(id, organizationId);
    const inside = isInsideGeoFence(latitude, longitude, location);
    return { inside, fenceType: location.fenceType };
  }

  async update(id: string, dto: UpdateWorkLocationDto, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);

    const GEOMETRY_KEYS = [
      'fenceType',
      'boundary',
      'latitude',
      'longitude',
      'radiusMeters',
    ] as const;
    const touchesGeometry = GEOMETRY_KEYS.some((k) => dto[k] !== undefined);

    const geometryData: Pick<
      Prisma.WorkLocationUpdateManyMutationInput,
      'fenceType' | 'boundary' | 'latitude' | 'longitude' | 'radiusMeters'
    > = {};

    if (touchesGeometry) {
      const fenceType = dto.fenceType ?? existing.fenceType;
      const boundary = (
        dto.boundary !== undefined ? dto.boundary : existing.boundary
      ) as Boundary | undefined;
      const latitude =
        dto.latitude !== undefined ? dto.latitude : existing.latitude;
      const longitude =
        dto.longitude !== undefined ? dto.longitude : existing.longitude;
      const radiusMeters =
        dto.radiusMeters !== undefined
          ? dto.radiusMeters
          : existing.radiusMeters;

      this.assertValidGeometry(fenceType, boundary, latitude, longitude);

      const summary = deriveCircleSummary(
        fenceType,
        boundary,
        latitude,
        longitude,
        radiusMeters || 200,
      );

      geometryData.fenceType = fenceType;
      geometryData.boundary =
        fenceType === FenceType.CIRCLE ? Prisma.JsonNull : boundary;
      geometryData.latitude = summary.latitude;
      geometryData.longitude = summary.longitude;
      geometryData.radiusMeters =
        fenceType === FenceType.CIRCLE
          ? Number(radiusMeters) || 200
          : summary.radiusMeters;
    }

    await this.scopedPrisma.workLocation.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...geometryData,
      },
    });

    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.workLocation.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Work location deleted' };
  }

  private assertValidGeometry(
    fenceType: FenceType,
    boundary: Boundary | undefined,
    latitude: number | null | undefined,
    longitude: number | null | undefined,
  ) {
    try {
      validateGeometry({ fenceType, boundary, latitude, longitude });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<WorkLocation> {
    const location = await this.scopedPrisma.workLocation.findFirst({
      where: { id, organizationId },
    });
    if (!location) throw new NotFoundException('Work location not found.');
    return location;
  }
}

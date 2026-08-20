import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditModule, Organization, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { signFileToken } from '../files/file-token';
import { validateOrgFields, validateIfsc } from './org-validators';
import {
  previewDocumentNumber,
  type DocumentNumberingEntry,
} from './document-numbering';

type Actor = Omit<User, 'password'>;

interface SignatoryEntry {
  id?: string;
  name?: string;
  designation?: string;
  signatureUrl?: string | null;
  signatureMeta?: { name: string; size: number } | null;
  isPrimary?: boolean;
}

const BRANDING_URL_FIELDS = [
  'companyLogoUrl',
  'faviconUrl',
  'reportLogoUrl',
  'emailLogoUrl',
  'sealUrl',
] as const;

// Whitelist of writable fields per Setup Wizard / Organization Settings
// section, ported verbatim from the old system's SECTION_FIELDS — the real
// security boundary: a client can send any JSON body, only these keys are
// ever written per section. `employeeTypes` and `workArrangement` are valid
// sections but aren't part of the 9-step wizard flow — edited elsewhere
// (Employees page / a settings toggle), same as before.
// The 7 keys Organization.attendancePayrollPrefs and
// orgPayrollAttendancePrefs both carry identically-named — see
// updateSection's 'attendancePayroll' branch and
// attendance-shift-config.ts's OrganizationAttendancePrefs.
const ATTENDANCE_PREFS_KEYS = [
  'defaultShiftStartTime',
  'defaultShiftEndTime',
  'defaultLateInThresholdMinutes',
  'defaultEarlyOutThresholdMinutes',
  'defaultMinHoursForPresent',
  'defaultMinHoursForHalfDay',
  'weekendDays',
] as const;

const SECTION_FIELDS: Record<string, string[]> = {
  profile: ['companyName', 'legalName', 'tagline', 'description'],
  registration: [
    'gstin',
    'pan',
    'tan',
    'cin',
    'registrationNumber',
    'lin',
    'msmeRegistrationNumber',
    'epfoEstablishmentCode',
    'esicEmployerCode',
    'ptRegistrationNumber',
    'labourLicenseNumber',
  ],
  contact: [
    'registeredAddress',
    'corporateAddress',
    'city',
    'state',
    'country',
    'pincode',
    'phone',
    'mobile',
    'contactEmail',
    'website',
  ],
  branding: [
    'primaryColor',
    'secondaryColor',
    'companyLogoUrl',
    'faviconUrl',
    'reportLogoUrl',
    'emailLogoUrl',
    'assetMeta',
  ],
  signatory: ['signatories', 'sealUrl'],
  banking: ['banking'],
  policies: ['policies'],
  attendancePayroll: ['orgPayrollAttendancePrefs'],
  documentNumbering: ['documentNumbering'],
  employeeTypes: ['customEmployeeTypes'],
  workArrangement: ['enableWFH'],
};

const REQUIRED_FOR_COMPLETION = [
  'companyName',
  'contactEmail',
  'phone',
  'registeredAddress',
  'city',
  'state',
  'country',
  'pincode',
];

@Injectable()
export class OrganizationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private async findOrThrow(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) throw new NotFoundException('Organization not found.');
    return org;
  }

  // Stored URL fields hold durable relativeKeys (never signed URLs — see
  // file-token.ts), so every response that surfaces one signs it fresh,
  // same pattern as PolicyDocument's withSignedUrl in the documents module.
  private withSignedUrls(org: Organization) {
    // faceApiKey is a webhook secret, not settings data — shown once at
    // generation time only (regenerateFaceApiKey's return value), never on
    // a read path, same "not retrievable afterwards" handling as a
    // generated employee password.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the secret deliberately
    const { faceApiKey, ...rest } = org;
    const signed: Record<string, unknown> = { ...rest };
    for (const field of BRANDING_URL_FIELDS) {
      const value = org[field];
      if (value) signed[field] = `/files/${signFileToken(org.id, value)}`;
    }
    const signatories = org.signatories as unknown as SignatoryEntry[];
    if (Array.isArray(signatories)) {
      signed.signatories = signatories.map((s) => ({
        ...s,
        signatureUrl: s.signatureUrl
          ? `/files/${signFileToken(org.id, s.signatureUrl)}`
          : s.signatureUrl,
      }));
    }
    return signed;
  }

  async getFull(organizationId: string, actor: Actor) {
    const org = await this.findOrThrow(organizationId);
    return { ...this.withSignedUrls(org), canEdit: actor.role === Role.ADMIN };
  }

  // Deliberately never exposes registration/banking/contact data — safe to
  // read by any authenticated user (used for in-app branding, e.g. logo in
  // the header), unlike the old system's stale "public" naming (it's
  // actually authenticated too, see org-validators research notes).
  async getPublicBranding(organizationId: string) {
    const org = await this.findOrThrow(organizationId);
    const signed = this.withSignedUrls(org);
    return {
      isInitialized: org.isInitialized,
      companyName: org.companyName,
      tagline: org.tagline,
      companyLogoUrl: signed.companyLogoUrl,
      faviconUrl: signed.faviconUrl,
      primaryColor: org.primaryColor,
      secondaryColor: org.secondaryColor,
      enableWFH: org.enableWFH,
    };
  }

  async updateSection(
    organizationId: string,
    section: string,
    body: Record<string, unknown>,
    actorId: string,
  ) {
    const allowedFields = SECTION_FIELDS[section];
    if (!allowedFields) {
      throw new BadRequestException(`Unknown settings section: ${section}`);
    }

    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) data[field] = body[field];
    }

    if (section === 'registration' || section === 'contact') {
      const error = validateOrgFields(data);
      if (error) throw new BadRequestException(error);
    }
    if (section === 'banking') {
      const banking = data.banking as { ifscCode?: string } | undefined;
      if (banking?.ifscCode && !validateIfsc(banking.ifscCode)) {
        throw new BadRequestException('ifscCode is not in a valid format.');
      }
    }
    if (section === 'attendancePayroll' && data.orgPayrollAttendancePrefs) {
      // attendancePayrollPrefs (read by AttendanceService.
      // recalculateAttendanceForDay) had no write path at all before this
      // — an admin editing shift timings/thresholds here via the Setup
      // Wizard silently never reached actual attendance calculation,
      // which kept using the schema's hardcoded defaults forever. Derive
      // the narrower field from the 7 overlapping keys on every write.
      // Merged against the org's *existing* orgPayrollAttendancePrefs
      // first (not just this request's body) so a partial update that
      // only touches an unrelated key (e.g. enableOvertime) can't
      // overwrite attendancePayrollPrefs with an incomplete object.
      const existingOrg = await this.findOrThrow(organizationId);
      const effectivePrefs = {
        ...(existingOrg.orgPayrollAttendancePrefs as Record<string, unknown>),
        ...(data.orgPayrollAttendancePrefs as Record<string, unknown>),
      };
      data.attendancePayrollPrefs = ATTENDANCE_PREFS_KEYS.reduce(
        (acc, key) => {
          if (key in effectivePrefs) acc[key] = effectivePrefs[key];
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }

    // Optional wizard-progress advancement, allowed alongside any section's
    // payload.
    if (typeof body.setupStep === 'number') {
      data.setupStep = body.setupStep;
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });

    await this.auditLogService.log({
      actorId,
      action: 'ORGANIZATION_SETTINGS_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { section, fields: Object.keys(data) },
    });

    return this.withSignedUrls(await this.findOrThrow(organizationId));
  }

  async completeSetup(organizationId: string, actorId: string) {
    const org = await this.findOrThrow(organizationId);

    const missing = REQUIRED_FOR_COMPLETION.filter((field) => {
      const value = (org as unknown as Record<string, unknown>)[field];
      return typeof value !== 'string' || !value.trim();
    });
    if (missing.length > 0) {
      throw new BadRequestException(
        `Complete these required fields before finishing setup: ${missing.join(', ')}`,
      );
    }

    const error = validateOrgFields(org);
    if (error) throw new BadRequestException(error);

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        isInitialized: true,
        initializedAt: new Date(),
        initializedById: actorId,
      },
    });

    await this.auditLogService.log({
      actorId,
      action: 'ORGANIZATION_SETUP_COMPLETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
    });

    return this.withSignedUrls(await this.findOrThrow(organizationId));
  }

  async resetSetup(organizationId: string, actorId: string) {
    await this.findOrThrow(organizationId);
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { isInitialized: false },
    });

    await this.auditLogService.log({
      actorId,
      action: 'ORGANIZATION_SETUP_RESET',
      module: AuditModule.ORGANIZATION,
      organizationId,
    });

    return this.withSignedUrls(await this.findOrThrow(organizationId));
  }

  // Generates (or rotates) this org's own Face API webhook key — replaces
  // the old single process-wide FACE_API_KEY env var that authenticated
  // every organization's webhook with one shared secret (a cross-tenant
  // forgery vector: anyone holding it could punch attendance for ANY org
  // by setting an arbitrary organizationId in the payload). Shown once in
  // the response, same "never shown again" pattern as a generated employee
  // password — the hashed/plain value isn't retrievable afterwards, only
  // regenerable.
  async regenerateFaceApiKey(organizationId: string, actorId: string) {
    await this.findOrThrow(organizationId);
    const key = crypto.randomBytes(24).toString('base64url');
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { faceApiKey: key },
    });

    await this.auditLogService.log({
      actorId,
      action: 'ORGANIZATION_FACE_API_KEY_REGENERATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
    });

    return { faceApiKey: key };
  }

  async previewDocumentNumber(organizationId: string, type: string) {
    const org = await this.findOrThrow(organizationId);
    const numbering = org.documentNumbering as unknown as Record<
      string,
      DocumentNumberingEntry
    >;
    const entry = numbering[type];
    if (!entry) {
      throw new BadRequestException(`Unknown document type: ${type}`);
    }
    return { preview: previewDocumentNumber(entry) };
  }
}

// Purpose: Backs the multi-step Setup Wizard / Organization Settings screens — per-section field writes,
// branding/logo URL signing, setup completion/reset, and the Face API webhook key.
// Responsibilities: Owns SECTION_FIELDS as the real security boundary (a client can send any JSON body, only
// whitelisted keys per section are ever written) and derives the narrower attendancePayrollPrefs from
// orgPayrollAttendancePrefs on every policies-section write that includes it.
// Important: regenerateFaceApiKey() replaces the old single process-wide FACE_API_KEY that let anyone
// holding it forge attendance webhooks for ANY organization; the generated key is shown once and never
// exposed again on a read path, same as a generated employee password.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditModule, Organization, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { frontendUrl } from '../common/frontend-url';
import {
  signFileToken,
  resolveIncomingFileValue,
  SESSION_ASSET_TTL_SECONDS,
} from '../files/file-token';
import { validateOrgFields } from './org-validators';
import { RedisCacheService } from '../common/redis-cache';
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
// updateSection's 'policies' branch and attendance-shift-config.ts's
// OrganizationAttendancePrefs.
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
  // companyLogoUrl/assetMeta are also editable from this tab (the Setup
  // Wizard's Company Profile step has its own logo uploader alongside
  // Branding's) — must be whitelisted here too, or a save from this tab
  // silently drops the logo the user just uploaded.
  profile: [
    'companyName',
    'legalName',
    'tagline',
    'description',
    'companyLogoUrl',
    'assetMeta',
  ],
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
  // Combined General Settings tab — org.policies and the shift-default
  // blob save together from one PATCH now (previously a separate
  // 'attendancePayroll' section/tab).
  policies: ['policies', 'orgPayrollAttendancePrefs'],
  documentNumbering: ['documentNumbering'],
  employeeTypes: ['customEmployeeTypes'],
  workArrangement: ['enableWFH'],
};

const REQUIRED_FOR_COMPLETION = [
  'companyName',
  'legalName',
  'companyLogoUrl',
  'contactEmail',
  'phone',
  'website',
  'registeredAddress',
  'corporateAddress',
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
    private readonly emailService: EmailService,
    private readonly cache: RedisCacheService,
    private readonly emailTemplatesService: EmailTemplatesService,
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
      if (value) {
        signed[field] =
          `/files/${signFileToken(org.id, value, SESSION_ASSET_TTL_SECONDS)}`;
      }
    }
    const signatories = org.signatories as unknown as SignatoryEntry[];
    if (Array.isArray(signatories)) {
      signed.signatories = signatories.map((s) => ({
        ...s,
        signatureUrl: s.signatureUrl
          ? `/files/${signFileToken(org.id, s.signatureUrl, SESSION_ASSET_TTL_SECONDS)}`
          : s.signatureUrl,
      }));
    }
    return signed;
  }

  async getFull(organizationId: string, actor: Actor) {
    const org = await this.findOrThrow(organizationId);
    return { ...this.withSignedUrls(org), canEdit: actor.role === Role.ADMIN };
  }

  // Deliberately never exposes registration/contact data — safe to
  // read by any authenticated user (used for in-app branding, e.g. logo in
  // the header), unlike the old system's stale "public" naming (it's
  // actually authenticated too, see org-validators research notes).
  async getPublicBranding(organizationId: string) {
    const org = await this.findOrThrow(organizationId);
    const signed = this.withSignedUrls(org);
    const policies = (org.policies ?? {}) as {
      currencySymbol?: string;
      defaultNoticeDays?: number;
      dateFormat?: string;
      timeFormat?: string;
    };
    const attendancePayrollPrefs = (org.orgPayrollAttendancePrefs ?? {}) as {
      enableTaxDeclaration?: boolean;
    };
    return {
      isInitialized: org.isInitialized,
      companyName: org.companyName,
      tagline: org.tagline,
      companyLogoUrl: signed.companyLogoUrl,
      // Durable relativeKey (never a signed URL — see file-token.ts),
      // alongside the ready-to-display signed companyLogoUrl above — needed
      // by anything that wants to *persist* the org's logo elsewhere (e.g.
      // Payroll Templates prefilling a new template), since storing the
      // signed form would silently expire and 404 later.
      companyLogoKey: org.companyLogoUrl,
      faviconUrl: signed.faviconUrl,
      primaryColor: org.primaryColor,
      secondaryColor: org.secondaryColor,
      enableWFH: org.enableWFH,
      // Drives every hardcoded-₹ display across the app (see
      // frontend/src/utils/currency.ts) — read from Policies' currency
      // symbol so switching it in Setup/Organization Settings changes the
      // symbol everywhere, not just the Policies tab itself.
      currencySymbol: policies.currencySymbol || '₹',
      // Lets Offboarding suggest a Last Working Day (resignation date +
      // this many days) without every caller needing ADMIN-only access to
      // the full /organizations/settings payload.
      defaultNoticeDays: Number(policies.defaultNoticeDays) || 30,
      // Drives every date/time display across the app (see
      // frontend/src/utils/date.js and backend-v2/src/payroll/format-date.ts)
      // — same "read from Policies, apply everywhere" pattern as
      // currencySymbol above, not hardcoded to DD-MM-YYYY/12-hour.
      dateFormat: ['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'].includes(
        policies.dateFormat ?? '',
      )
        ? policies.dateFormat
        : 'DD-MM-YYYY',
      timeFormat: policies.timeFormat === '24' ? '24' : '12',
      // Org-wide "employee can't see or do anything on Tax Declaration"
      // switch — defaults to enabled (undefined !== false) so orgs that
      // predate this setting keep working exactly as before. Read by
      // TaxDeclarationsService (blocks the EMPLOYEE-tier endpoints
      // entirely when off) and the frontend (hides the nav link + shows a
      // disabled state instead of the form).
      enableTaxDeclaration:
        attendancePayrollPrefs.enableTaxDeclaration !== false,
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

    // Same trap resolveIncomingFileValue's comment describes for Payroll
    // Templates — the client's own state for a logo/signature field is
    // whatever the last GET response signed it into, and most saves never
    // touch that specific field, so a stale signed URL would otherwise
    // silently overwrite the durable key on every unrelated save.
    const needsBrandingFix = BRANDING_URL_FIELDS.some((f) => f in data);
    const signatoriesIncoming = data.signatories as
      SignatoryEntry[] | undefined;
    if (needsBrandingFix || signatoriesIncoming) {
      const existingOrg = await this.findOrThrow(organizationId);
      for (const field of BRANDING_URL_FIELDS) {
        if (field in data) {
          data[field] = resolveIncomingFileValue(
            organizationId,
            data[field],
            existingOrg[field],
          );
        }
      }
      if (signatoriesIncoming) {
        const existingByI = existingOrg.signatories as unknown as
          SignatoryEntry[] | null;
        data.signatories = signatoriesIncoming.map((s, i) => ({
          ...s,
          signatureUrl: resolveIncomingFileValue(
            organizationId,
            s.signatureUrl ?? null,
            existingByI?.[i]?.signatureUrl ?? null,
          ),
        }));
      }
    }

    if (section === 'registration' || section === 'contact') {
      const error = validateOrgFields(data);
      if (error) throw new BadRequestException(error);
    }
    if (section === 'policies' && data.orgPayrollAttendancePrefs) {
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

    if (section === 'policies') {
      // PayrollSettingsService.getOrCreate overlays currency/currency
      // Symbol/financialYearStartMonth from this same policies JSON on
      // every read, cached for 5 minutes — without this, a Policies save
      // wouldn't reach real payroll calculations for up to that long.
      await this.cache.invalidate(`payrollsettings:${organizationId}`);
    }

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

    // Fire-and-forget confirmation email once the wizard is done — to the
    // admin who completed it, cc'ing every other active employee (same
    // "notify everyone" convention as the HR-events birthday/anniversary
    // mail). EmailService.send() never throws, so this can't fail
    // completeSetup itself.
    const activeUsers = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true, email: true },
    });
    const actor = activeUsers.find((u) => u.id === actorId);
    if (actor) {
      const finalOrg = await this.findOrThrow(organizationId);
      const cc = activeUsers
        .map((u) => u.email)
        .filter((email) => email !== actor.email);
      const companyName = finalOrg.companyName || 'your organization';
      const fallbackHtml = setupCompleteEmailHtml({
        recipientName: actor.name,
        organizationName: companyName,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'SETUP_COMPLETE',
        { employeeName: actor.name, companyName },
        {
          subject: `Your ${companyName} HRMS Setup Is Complete`,
          html: fallbackHtml,
        },
      );
      await this.emailService.send({
        to: actor.email,
        subject: rendered.subject,
        html: rendered.html,
        ...(cc.length && { cc }),
      });
    }

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

// Sent once, right after completeSetup() succeeds — see the call site
// above. Table-based layout + inline styles (not the raw <div>-and-class
// markup the rest of this file's simpler emails use) since this one is
// meant to actually look designed rather than be a quick notice, and
// inline styles are what survive stripping in real email clients.
function setupCompleteEmailHtml(params: {
  recipientName: string;
  organizationName: string;
}): string {
  const loginUrl = `${frontendUrl()}/login`;
  const items = [
    'Add and manage employees',
    'Manage attendance',
    'Manage leave',
    'Process payroll',
    'Configure HRMS settings',
    'Access workforce information and reports',
  ];
  return `
  <div style="background-color:#f4f5f7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr>
        <td style="background:#14161d;padding:28px 32px;">
          <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.2px;">D&rsquo;Bugged Programmers HRMS</span>
        </td>
      </tr>
      <tr>
        <td style="padding:36px 32px 8px;">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#14161d;">You&rsquo;re All Set</h1>
          <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#3f3f46;">Hello ${params.recipientName},</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#3f3f46;">
            Your basic HRMS setup for <strong>${params.organizationName}</strong> has been successfully completed.
            Your organization is now ready to use D&rsquo;Bugged Programmers HRMS. Log in to your account and start
            managing your workforce from one place.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;">
            <tr>
              <td style="padding:16px 20px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:top;padding-right:12px;">
                      <span style="display:inline-block;width:28px;height:28px;line-height:28px;border-radius:50%;background:#10b981;color:#ffffff;text-align:center;font-size:15px;font-weight:700;">&check;</span>
                    </td>
                    <td>
                      <p style="margin:0;font-size:14px;font-weight:600;color:#065f46;">Setup Complete</p>
                      <p style="margin:2px 0 0;font-size:13px;color:#047857;">Your organization is ready to use HRMS.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 8px;">
          <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#14161d;">Start Using Your HRMS</p>
          <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;">You can now:</p>
          <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;line-height:1.9;color:#3f3f46;">
            ${items.map((item) => `<li>${item}</li>`).join('')}
          </ul>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 28px;" align="center">
          <a href="${loginUrl}" style="display:inline-block;background:#5546e0;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">Log in to HRMS &rarr;</a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 32px;">
          <p style="margin:0 0 8px;font-size:13px;color:#71717a;">You&rsquo;re all set. Log in whenever you&rsquo;re ready to get started.</p>
          <p style="margin:0;font-size:13px;color:#71717a;">If you need any assistance, please contact our support team.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#a1a1aa;">Regards,<br>D&rsquo;Bugged Programmers Team<br>HRMS Platform</p>
        </td>
      </tr>
    </table>
  </div>`;
}

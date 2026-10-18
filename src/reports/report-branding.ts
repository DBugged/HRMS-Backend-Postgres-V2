// Purpose: Wires Organization Settings > Branding > Report Logo into every report/export in the app —
//   it was captured and validated but nothing actually read it (the upload hint claimed "Used on payroll/
//   HR/tax reports and PDFs", which wasn't true until this file existed).
// Responsibilities: Looks up the org's reportLogoUrl and reads its bytes; sendReportBranded() is the drop-in
//   replacement for report-export.ts's sendReport() that every report controller should call instead.
import type { Response } from 'express';
import { readStoredFile } from '../files/file-storage.config';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sendReport, type SendReportInput } from './report-export';

// Drop-in replacement for sendReport() — every report controller endpoint
// should call this instead, so the org's Report Logo (and, if enabled,
// the watermark drawn from it — see common/pdf-watermark.ts) show up on
// every generated report without each individual report-building method
// (in ReportsService/PayrollReportsService/EmployeeTimelineController)
// needing to know or care about branding.
export async function sendReportBranded(
  res: Response,
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
  input: SendReportInput,
): Promise<void> {
  const org = await scopedPrisma.organization.findFirst({
    where: { id: organizationId },
    select: { reportLogoUrl: true, companyLogoUrl: true, watermarkLogo: true },
  });
  // The Report Logo when one was uploaded, otherwise the company logo - an org that only ever set the company logo
  // (the common case) still gets a logo and, if enabled, the watermark on its reports, as payslips and letters do.
  const logoKey = org?.reportLogoUrl || org?.companyLogoUrl;
  const logoBuffer = logoKey
    ? await readStoredFile(logoKey).catch(() => null)
    : null;
  return sendReport(res, {
    ...input,
    logoBuffer,
    watermarkEnabled: org?.watermarkLogo ?? false,
  });
}

// The org's Report Logo (company logo as the fallback) and whether the watermark is on, for single-document PDFs
// (e.g. Form 130) that are not routed through sendReport().
export async function loadReportBranding(
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
): Promise<{ logo: Buffer | null; watermarkEnabled: boolean }> {
  const org = await scopedPrisma.organization.findFirst({
    where: { id: organizationId },
    select: { reportLogoUrl: true, companyLogoUrl: true, watermarkLogo: true },
  });
  const key = org?.reportLogoUrl || org?.companyLogoUrl;
  return {
    logo: key ? await readStoredFile(key).catch(() => null) : null,
    watermarkEnabled: org?.watermarkLogo ?? false,
  };
}

export async function loadReportLogo(
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
): Promise<Buffer | null> {
  return (await loadReportBranding(scopedPrisma, organizationId)).logo;
}

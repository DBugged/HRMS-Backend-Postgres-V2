// Purpose: Wires Organization Settings > Branding > Report Logo into every report/export in the app —
//   it was captured and validated but nothing actually read it (the upload hint claimed "Used on payroll/
//   HR/tax reports and PDFs", which wasn't true until this file existed).
// Responsibilities: Looks up the org's reportLogoUrl and reads its bytes; sendReportBranded() is the drop-in
//   replacement for report-export.ts's sendReport() that every report controller should call instead.
import type { Response } from 'express';
import { readStoredFile } from '../files/file-storage.config';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sendReport, type SendReportInput } from './report-export';

// Returns null (not throws) when the org has no Report Logo set, or the
// stored file can't be read — every caller treats "no logo" as the normal,
// non-fatal case, same convention readStoredFile itself already uses.
export async function getReportLogoBuffer(
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
): Promise<Buffer | null> {
  const org = await scopedPrisma.organization.findFirst({
    where: { id: organizationId },
    select: { reportLogoUrl: true },
  });
  if (!org?.reportLogoUrl) return null;
  return readStoredFile(org.reportLogoUrl).catch(() => null);
}

// Drop-in replacement for sendReport() — every report controller endpoint
// should call this instead, so the org's Report Logo shows up on every
// generated report without each individual report-building method (in
// ReportsService/PayrollReportsService/EmployeeTimelineController) needing
// to know or care about branding.
export async function sendReportBranded(
  res: Response,
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
  input: SendReportInput,
): Promise<void> {
  const logoBuffer = await getReportLogoBuffer(scopedPrisma, organizationId);
  return sendReport(res, { ...input, logoBuffer });
}

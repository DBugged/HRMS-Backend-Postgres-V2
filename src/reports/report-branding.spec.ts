const readStoredFile = jest.fn(async (key: string) =>
  Buffer.from(`file:${key}`),
);
const sendReport = jest.fn(async () => undefined);
jest.mock('../files/file-storage.config', () => ({ readStoredFile }));
jest.mock('./report-export', () => ({ sendReport }));

import { loadReportBranding, sendReportBranded } from './report-branding';

const prismaWith = (org: Record<string, unknown>) =>
  ({ organization: { findFirst: async () => org } }) as never;

describe('report branding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the Report Logo when there is one', async () => {
    await sendReportBranded(
      {} as never,
      prismaWith({
        reportLogoUrl: 'r.png',
        companyLogoUrl: 'c.png',
        watermarkLogo: true,
      }),
      'o',
      {} as never,
    );
    expect(readStoredFile).toHaveBeenCalledWith('r.png');
    expect(sendReport).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ watermarkEnabled: true }),
    );
  });

  it('falls back to the company logo, so an org that only set that still gets the logo and watermark', async () => {
    await sendReportBranded(
      {} as never,
      prismaWith({
        reportLogoUrl: null,
        companyLogoUrl: 'c.png',
        watermarkLogo: true,
      }),
      'o',
      {} as never,
    );
    expect(readStoredFile).toHaveBeenCalledWith('c.png');
    const input = sendReport.mock.calls[0][1] as {
      logoBuffer: Buffer | null;
      watermarkEnabled: boolean;
    };
    expect(input.logoBuffer?.toString()).toBe('file:c.png');
    expect(input.watermarkEnabled).toBe(true);
  });

  it('no logo at all: nothing to draw, and single-document PDFs get the same answer', async () => {
    const branding = await loadReportBranding(
      prismaWith({ watermarkLogo: false }),
      'o',
    );
    expect(branding).toEqual({ logo: null, watermarkEnabled: false });
  });
});

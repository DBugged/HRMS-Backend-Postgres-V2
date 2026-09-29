import { Injectable, Logger } from '@nestjs/common';

/**
 * Calls OUT to the separate HRMS Control Center (its own DB, own Super
 * Admin auth) the moment a new customer org registers, so it shows up
 * there with no manual step. This is the mirror image of PlatformS2sGuard's
 * /internal/* routes (Control Center -> this app); this client is
 * this app -> Control Center, authenticated with the same shared secret.
 *
 * Deliberately never throws — same policy as EmailService.send(): a
 * registration must never fail because the Control Center is unreachable
 * or misconfigured. Every failure is logged with enough detail to
 * reconcile manually (the org can always be added there by hand).
 */
@Injectable()
export class ControlCenterClient {
  private readonly logger = new Logger(ControlCenterClient.name);

  async provisionOrg(input: {
    name: string;
    region?: string;
    billingEmail?: string;
    externalHrmsOrgId: string;
  }): Promise<void> {
    const baseUrl = process.env.CONTROL_CENTER_BASE_URL;
    const token = process.env.PLATFORM_S2S_TOKEN;
    if (!baseUrl || !token) {
      this.logger.warn(
        'Skipping Control Center provisioning: CONTROL_CENTER_BASE_URL or PLATFORM_S2S_TOKEN not set.',
      );
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${baseUrl}/api/v1/organizations/provision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `Control Center provisioning returned ${res.status} for org ${input.externalHrmsOrgId}: ${await res.text().catch(() => '')}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Control Center provisioning failed for org ${input.externalHrmsOrgId}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

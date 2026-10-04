// Purpose: Registers phones (Expo push tokens) for the signed-in user and delivers push notifications for every
//   in-app Notification the system creates.
// Responsibilities: register/unregister a device, and notify() — look up the recipients' devices and preferences
//   (push on/off, muted categories) and send through the Expo push service.
// Important: notify() NEVER throws — a push problem must not fail the business action that created the
//   notification. Payroll pushes carry no text (see push-messages.ts). Sending is skipped when no devices exist, in
//   tests, or when PUSH_ENABLED=false.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationCategory, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_DEVICES_PER_USER,
  buildExpoMessages,
  chunk,
  deadTokens,
  type PushInput,
} from './push-messages';

type Actor = Omit<User, 'password'>;

export interface PushTarget extends PushInput {
  organizationId: string;
  userId: string;
}

interface PrefsShape {
  mutedCategories?: NotificationCategory[];
  pushEnabled?: boolean;
}

const EXPO_URL =
  process.env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
  ) {}

  private get enabled(): boolean {
    return (
      process.env.NODE_ENV !== 'test' && process.env.PUSH_ENABLED !== 'false'
    );
  }

  // One token belongs to one install. If another account (even in another organisation) signed in on this phone
  // before, that row is re-pointed here — otherwise the previous user's alerts would keep landing on this phone.
  async register(
    actor: Actor,
    organizationId: string,
    dto: { token: string; platform: string; deviceName?: string },
  ) {
    const data = {
      organizationId,
      userId: actor.id,
      platform: dto.platform,
      deviceName: dto.deviceName ?? '',
      lastSeenAt: new Date(),
    };
    // Deliberately unscoped: the token's previous owner may be in a different organisation.
    const device = await this.prisma.pushDevice.upsert({
      where: { token: dto.token },
      create: { token: dto.token, ...data },
      update: data,
    });
    // Keep the newest few phones per user.
    const mine = await this.scopedPrisma.pushDevice.findMany({
      where: { organizationId, userId: actor.id },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true },
    });
    const stale = mine.slice(MAX_DEVICES_PER_USER).map((d) => d.id);
    if (stale.length) {
      await this.scopedPrisma.pushDevice.deleteMany({
        where: { organizationId, id: { in: stale } },
      });
    }
    return { registered: true, id: device.id };
  }

  async unregister(actor: Actor, organizationId: string, token: string) {
    const { count } = await this.scopedPrisma.pushDevice.deleteMany({
      where: { organizationId, userId: actor.id, token },
    });
    return { removed: count };
  }

  // Fire-and-forget entry point used by NotificationsService after it writes the in-app rows.
  notify(targets: PushTarget[]): void {
    if (!this.enabled || targets.length === 0) return;
    void this.deliver(targets).catch((err) =>
      this.logger.warn(`Push delivery failed: ${(err as Error).message}`),
    );
  }

  private async deliver(targets: PushTarget[]): Promise<void> {
    const byOrg = new Map<string, PushTarget[]>();
    for (const t of targets)
      byOrg.set(t.organizationId, [...(byOrg.get(t.organizationId) ?? []), t]);

    for (const [organizationId, list] of byOrg) {
      const userIds = [...new Set(list.map((t) => t.userId))];
      const [devices, users] = await Promise.all([
        this.scopedPrisma.pushDevice.findMany({
          where: { organizationId, userId: { in: userIds } },
          select: { userId: true, token: true },
        }),
        this.scopedPrisma.user.findMany({
          where: { organizationId, id: { in: userIds }, isActive: true },
          select: { id: true, notificationPreferences: true },
        }),
      ]);
      if (devices.length === 0) continue;
      const prefs = new Map(
        users.map((u) => [
          u.id,
          (u.notificationPreferences ?? {}) as PrefsShape,
        ]),
      );
      const messages = list.flatMap((t) => {
        const p = prefs.get(t.userId);
        if (!p) return []; // inactive / unknown user
        if (p.pushEnabled === false) return [];
        if (
          (p.mutedCategories ?? []).includes(t.category as NotificationCategory)
        )
          return [];
        const tokens = devices
          .filter((d) => d.userId === t.userId)
          .map((d) => d.token);
        return buildExpoMessages(tokens, t);
      });

      for (const batch of chunk(messages)) {
        await this.send(organizationId, batch);
      }
    }
  }

  private async send(
    organizationId: string,
    batch: ReturnType<typeof buildExpoMessages>,
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Expo push service answered ${res.status}`);
        return;
      }
      const json = (await res.json()) as {
        data?: { status?: string; details?: { error?: string } }[];
      };
      const dead = deadTokens(batch, json.data ?? []);
      if (dead.length) {
        await this.scopedPrisma.pushDevice.deleteMany({
          where: { organizationId, token: { in: dead } },
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

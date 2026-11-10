// Purpose: the product's own name and logo ("D'Rect HR" by default), set by the platform team in the Control Center.
// Responsibilities: reads/writes the two cc_settings rows, caches them for 30s, and swaps the default name for the saved one in
//   outgoing email. Web and mobile read the same values from the public /platform-brand endpoint.
// Important: fails open - if the lookup errors the default name is used, so a hiccup can never block a page or an email.
//   The logo is kept as a small image data URL (<= 400 KB) so it needs no file storage and works on every client.
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

export const DEFAULT_BRAND_NAME = "D'Rect HR";
const NAME_KEY = 'platform.brandName';
const LOGO_KEY = 'platform.brandLogo';
const FROM_NAME_KEY = 'platform.emailFromName';
const FROM_ADDRESS_KEY = 'platform.emailFromAddress';
const REPLY_TO_KEY = 'platform.emailReplyTo';
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const TTL_MS = 30_000;
const MAX_LOGO_CHARS = 400_000;
const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export interface PlatformBrand { name: string; logoUrl: string | null }
/** The sender of platform emails (sign-up, password reset, invoices). Empty strings mean "not set": the environment default is used. */
export interface PlatformSender { fromName: string; fromAddress: string; replyTo: string }

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Every way the default name is written in code and in stored email templates.
const DEFAULT_FORMS = ["D'Rect HR", 'D&rsquo;Rect HR', 'D&apos;Rect HR', 'D&#39;Rect HR', 'D’Rect HR', "D'RectHR", 'D&rsquo;RectHR', 'D&apos;RectHR', 'D’RectHR'];

@Injectable()
export class PlatformBrandService {
  private readonly logger = new Logger(PlatformBrandService.name);
  private cache: { at: number; brand: PlatformBrand } | null = null;
  private senderCache: { at: number; sender: PlatformSender } | null = null;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  async get(): Promise<PlatformBrand> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.brand;
    let brand: PlatformBrand = { name: DEFAULT_BRAND_NAME, logoUrl: null };
    try {
      const rows = await this.prisma.ccSetting.findMany({ where: { key: { in: [NAME_KEY, LOGO_KEY] } } });
      const name = rows.find((r) => r.key === NAME_KEY)?.value;
      const logo = rows.find((r) => r.key === LOGO_KEY)?.value;
      brand = {
        name: typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_BRAND_NAME,
        logoUrl: typeof logo === 'string' && LOGO_RE.test(logo) ? logo : null,
      };
    } catch (e) {
      this.logger.warn(`Brand lookup failed, using the default: ${(e as Error).message}`);
    }
    this.cache = { at: Date.now(), brand };
    return brand;
  }

  async set(input: { name?: unknown; logo?: unknown }): Promise<PlatformBrand> {
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length < 2 || name.length > 40 || /[<>]/.test(name)) throw new BadRequestException('Name must be 2 to 40 characters and cannot contain < or >.');
      await this.upsert(NAME_KEY, name, 'The product name shown in the app, emails and documents.');
    }
    if (input.logo !== undefined) {
      if (input.logo === null || input.logo === '') {
        await this.upsert(LOGO_KEY, '', 'The product logo (image data), shown in the app header and sign-in screens.');
      } else {
        const logo = typeof input.logo === 'string' ? input.logo : '';
        if (!LOGO_RE.test(logo)) throw new BadRequestException('The logo must be a PNG, JPEG, WebP or SVG image.');
        if (logo.length > MAX_LOGO_CHARS) throw new BadRequestException('The logo is too large. Keep it under 300 KB.');
        await this.upsert(LOGO_KEY, logo, 'The product logo (image data), shown in the app header and sign-in screens.');
      }
    }
    this.cache = null;
    return this.get();
  }

  private upsert(key: string, value: string, description: string) {
    return this.prisma.ccSetting.upsert({
      where: { key },
      create: { key, value: value as never, type: 'string', restricted: false, description },
      update: { value: value as never },
    });
  }

  async getSender(): Promise<PlatformSender> {
    if (this.senderCache && Date.now() - this.senderCache.at < TTL_MS) return this.senderCache.sender;
    let sender: PlatformSender = { fromName: '', fromAddress: '', replyTo: '' };
    try {
      const rows = await this.prisma.ccSetting.findMany({ where: { key: { in: [FROM_NAME_KEY, FROM_ADDRESS_KEY, REPLY_TO_KEY] } } });
      const val = (k: string) => {
        const v = rows.find((r) => r.key === k)?.value;
        return typeof v === 'string' ? v.trim() : '';
      };
      sender = { fromName: val(FROM_NAME_KEY), fromAddress: val(FROM_ADDRESS_KEY), replyTo: val(REPLY_TO_KEY) };
    } catch (e) {
      this.logger.warn(`Email sender lookup failed, using the environment default: ${(e as Error).message}`);
    }
    this.senderCache = { at: Date.now(), sender };
    return sender;
  }

  /** Checks a sender before it is tested or saved. Blank address and reply-to are allowed (they fall back to the environment). */
  validateSender(input: { fromName?: unknown; fromAddress?: unknown; replyTo?: unknown }): PlatformSender {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const sender = { fromName: str(input.fromName), fromAddress: str(input.fromAddress).toLowerCase(), replyTo: str(input.replyTo).toLowerCase() };
    if (sender.fromName && (sender.fromName.length > 60 || /[<>"\r\n]/.test(sender.fromName))) throw new BadRequestException('Sender name must be up to 60 characters and cannot contain < > or quotes.');
    if (sender.fromAddress && !EMAIL_RE.test(sender.fromAddress)) throw new BadRequestException('Enter a valid From email address.');
    if (sender.replyTo && !EMAIL_RE.test(sender.replyTo)) throw new BadRequestException('Enter a valid reply-to email address.');
    return sender;
  }

  async setSender(input: { fromName?: unknown; fromAddress?: unknown; replyTo?: unknown }): Promise<PlatformSender> {
    const sender = this.validateSender(input);
    const note = 'Sender of platform emails (sign-up, password reset, invoices). Blank means the server default.';
    await this.upsert(FROM_NAME_KEY, sender.fromName, note);
    await this.upsert(FROM_ADDRESS_KEY, sender.fromAddress, note);
    await this.upsert(REPLY_TO_KEY, sender.replyTo, note);
    this.senderCache = null;
    return this.getSender();
  }

  /** Swaps the default product name for the saved one in an email subject (plain text) or body (html). */
  async applyToEmail(text: string, html: boolean): Promise<string> {
    if (!text || !text.includes('Rect')) return text;
    const { name } = await this.get();
    if (name === DEFAULT_BRAND_NAME) return text;
    const to = html ? escapeHtml(name) : name;
    let out = text;
    for (const f of DEFAULT_FORMS) out = out.split(f).join(to);
    return out;
  }
}

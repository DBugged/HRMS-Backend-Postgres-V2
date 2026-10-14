// Purpose: Writes the facts of a punch onto its selfie - when, where, how much battery, who - so the photo explains
//   itself when it is looked at on its own (in an export, a download, a dispute).
// Responsibilities: reads the uploaded selfie, draws a caption bar along the bottom, stores the result as a NEW file
//   and returns its key. The photo as taken is never changed or deleted; the caller keeps both keys.
// Important: stamping is best-effort. Any failure (not an image, unreadable, no fonts) returns null and the punch
//   carries on with the original photo. Time and place come from the server's own record of the punch; battery is what
//   the phone reported and is labelled that way.
import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { FONTS_DIR, ROBOTO_FILES } from '../common/fonts-dir';
import { readStoredFile, writeStoredFile } from '../files/file-storage.config';

export interface StampDetails {
  /** First line, for example "Check-in" or "Check-out" with the date and time already formatted. */
  title: string;
  /** "Name (CODE) - Company". */
  who: string;
  /** Coordinates and accuracy already formatted, or null when no location was taken. */
  place: string | null;
  /** 0-100 as reported by the phone, or null. */
  batteryPercent: number | null;
}

const FONT_FAMILY = 'HrmsStampRoboto';
const MAX_WIDTH = 1280;

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(
    path.join(FONTS_DIR, ROBOTO_FILES.regular),
    FONT_FAMILY,
  );
  GlobalFonts.registerFromPath(
    path.join(FONTS_DIR, ROBOTO_FILES.bold),
    `${FONT_FAMILY}Bold`,
  );
  fontsReady = true;
}

/** The caption lines for a punch, in the order they are drawn (pure, for tests). */
export function stampLines(d: StampDetails): string[] {
  const lines = [d.title];
  lines.push(d.place ?? 'Location not recorded');
  lines.push(
    d.batteryPercent === null
      ? 'Battery: not reported'
      : `Battery: ${d.batteryPercent}% (reported by device)`,
  );
  lines.push(d.who);
  return lines;
}

@Injectable()
export class SelfieStampService {
  private readonly logger = new Logger(SelfieStampService.name);

  /**
   * Stamps the selfie stored at `relativeKey` and returns the key of the stamped copy, or null when it could not be
   * done (the original is then used as it is).
   */
  async stamp(relativeKey: string, details: StampDetails): Promise<string | null> {
    try {
      const original = await readStoredFile(relativeKey);
      if (!original) return null;
      ensureFonts();
      const image = await loadImage(original);
      const scale = image.width > MAX_WIDTH ? MAX_WIDTH / image.width : 1;
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const lines = stampLines(details);
      const fontSize = Math.max(14, Math.round(width / 38));
      const lineGap = Math.round(fontSize * 0.35);
      const pad = Math.round(fontSize * 0.7);
      const barHeight = pad * 2 + lines.length * fontSize + (lines.length - 1) * lineGap;

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, width, height);
      ctx.fillStyle = 'rgba(10, 11, 16, 0.72)';
      ctx.fillRect(0, height - barHeight, width, barHeight);
      ctx.textBaseline = 'top';
      lines.forEach((line, i) => {
        ctx.font = `${i === 0 ? 'bold ' : ''}${fontSize}px ${i === 0 ? `${FONT_FAMILY}Bold` : FONT_FAMILY}`;
        ctx.fillStyle = i === 0 ? '#ffffff' : '#e5e7eb';
        ctx.fillText(
          line,
          pad,
          height - barHeight + pad + i * (fontSize + lineGap),
          width - pad * 2,
        );
      });

      const out = canvas.toBuffer('image/jpeg', 82);
      const dir = path.posix.dirname(relativeKey);
      const base = path.posix.basename(relativeKey, path.posix.extname(relativeKey));
      const stampedKey = `${dir}/${base}-stamped.jpg`;
      await writeStoredFile(stampedKey, out, 'image/jpeg');
      return stampedKey;
    } catch (err) {
      this.logger.warn(
        `Could not stamp selfie ${relativeKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

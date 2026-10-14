import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { UPLOAD_ROOT } from '../files/file-storage.config';
import { SelfieStampService } from './selfie-stamp.service';

// Runs the real thing against a real image on disk: the stamped copy must exist beside the original, be a readable
// image, keep the original untouched, and carry a visible caption bar (the bottom of the picture is no longer the
// plain photo).
describe('SelfieStampService (real image)', () => {
  const dir = path.join(UPLOAD_ROOT, 'stamp-test-org', 'selfies');
  const key = 'stamp-test-org/selfies/photo.jpg';

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const c = createCanvas(640, 480);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(0, 0, 640, 480);
    fs.writeFileSync(path.join(dir, 'photo.jpg'), c.toBuffer('image/jpeg', 90));
  });
  afterAll(() => {
    fs.rmSync(path.join(UPLOAD_ROOT, 'stamp-test-org'), { recursive: true, force: true });
  });

  it('writes a stamped copy, keeps the original, and darkens the caption area', async () => {
    const service = new SelfieStampService();
    const originalBefore = fs.readFileSync(path.join(dir, 'photo.jpg'));
    const stampedKey = await service.stamp(key, {
      title: 'Check-in - 14-10-2026, 09:02 AM',
      who: 'Asha Rao (DP-00007) - Demo Company',
      place: 'Lat 19.076000, Lng 72.877700 (+/-12 m)',
      batteryPercent: 78,
    });
    expect(stampedKey).toBe('stamp-test-org/selfies/photo-stamped.jpg');
    // The photo as taken is untouched.
    expect(fs.readFileSync(path.join(dir, 'photo.jpg')).equals(originalBefore)).toBe(true);
    const stamped = await loadImage(fs.readFileSync(path.join(UPLOAD_ROOT, stampedKey as string)));
    expect(stamped.width).toBe(640);
    expect(stamped.height).toBe(480);
    // Sample a pixel inside the caption bar and one at the top: the bar is much darker than the blue photo.
    const c = createCanvas(640, 480);
    const ctx = c.getContext('2d');
    ctx.drawImage(stamped, 0, 0);
    const top = ctx.getImageData(600, 10, 1, 1).data;
    const bar = ctx.getImageData(600, 470, 1, 1).data;
    // The caption text itself was drawn: the bar region holds light (near-white) text pixels, not just the dark fill.
    const region = ctx.getImageData(0, 380, 640, 100).data;
    let lightPixels = 0;
    for (let i = 0; i < region.length; i += 4) {
      if (region[i] > 200 && region[i + 1] > 200 && region[i + 2] > 200) lightPixels += 1;
    }
    expect(lightPixels).toBeGreaterThan(200);
    expect(top[2]).toBeGreaterThan(150);
    expect(bar[0] + bar[1] + bar[2]).toBeLessThan(top[0] + top[1] + top[2]);
  });

  it('returns null (and the punch keeps the original) when the file is missing or not an image', async () => {
    const service = new SelfieStampService();
    const base = { title: 't', who: 'w', place: null, batteryPercent: null };
    expect(await service.stamp('stamp-test-org/selfies/nope.jpg', base)).toBeNull();
    fs.writeFileSync(path.join(dir, 'notimage.jpg'), 'not an image');
    expect(await service.stamp('stamp-test-org/selfies/notimage.jpg', base)).toBeNull();
  });
});

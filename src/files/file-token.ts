import * as crypto from 'crypto';

// Signed, short-lived file-access tokens — the access-control mechanism for
// every uploaded file (branding assets, profile photos, punch selfies,
// policy documents). Plain <img src>/<link rel="icon">/embedded-PDF-viewer
// requests can't carry a Bearer auth header, so per-request session auth
// isn't an option here; instead each URL itself is the credential (the same
// model as an S3 presigned URL) — an HMAC-signed, tenant-bound, expiring
// token. Anyone holding a valid token can fetch that one file until it
// expires; a leaked URL goes stale on its own within minutes.
//
// The database NEVER stores one of these signed URLs — only the durable
// relativeKey (e.g. "<organizationId>/documents/<uuid>.pdf", relative to
// the uploads/ root). A token is minted fresh every time an API response
// serializes that key into a URL — storing a signed URL in the DB would
// silently start 403'ing once it expired.

const DEFAULT_TTL_SECONDS = 300; // 5 minutes — long enough for a page load/PDF render, short enough that a leaked link goes stale fast

export interface FileTokenClaim {
  organizationId: string;
  relativeKey: string;
}

function getSecret(): string {
  const secret = process.env.FILE_TOKEN_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error(
      'FILE_TOKEN_SECRET (or JWT_ACCESS_SECRET) must be set to sign file tokens.',
    );
  }
  return secret;
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

export function signFileToken(
  organizationId: string,
  relativeKey: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const payload = {
    o: organizationId,
    p: relativeKey,
    e: Date.now() + ttlSeconds * 1000,
  };
  const json = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', getSecret())
    .update(json)
    .digest('base64url');
  return `${json}.${sig}`;
}

export function verifyFileToken(token: string): FileTokenClaim | null {
  try {
    const [json, sig] = String(token).split('.');
    if (!json || !sig) return null;
    const expectedSig = crypto
      .createHmac('sha256', getSecret())
      .update(json)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(
      Buffer.from(json, 'base64url').toString('utf8'),
    ) as {
      o: string;
      p: string;
      e: number;
    };
    if (!payload.e || Date.now() > payload.e) return null;
    return { organizationId: payload.o, relativeKey: payload.p };
  } catch {
    return null;
  }
}

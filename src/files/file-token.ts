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

// For URLs that get parked in long-lived client state (the sidebar org
// logo, the header avatar — anything from OrgContext/AuthContext, held in
// memory for the whole session rather than fetched right before a single
// use) — the default 300s TTL was expiring mid-session, since neither
// context polls or re-signs in the background. A leaked link here is a
// company logo or profile photo, not a private document, so the longer
// window is an acceptable trade for "stays valid all session."
export const SESSION_ASSET_TTL_SECONDS = 60 * 60 * 24; // 24 hours

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

// Every write path that accepts one of these URL fields back from the
// client (Organization Settings' updateSection, PayrollTemplate create/
// update) faces the same trap: the client's own state for the field is
// whatever the last GET response signed it into (a `/files/<token>` URL,
// per the "never store a signed URL" rule above), and most edits never
// touch that specific field — so the signed, expiring form gets silently
// persisted right back into the DB, corrupting the durable key it was
// supposed to stay. This decodes a client-submitted value back to the
// durable relativeKey when it's one of these signed URLs; a plain
// relativeKey (from a fresh upload) or null (explicit clear) passes
// through unchanged. If the token can't be decoded (expired — same
// 5-minute TTL as any other file link — or tampered), `existing` is
// returned instead of the bad value, so a stale token in the client's
// state can never overwrite a still-good stored key.
export function resolveIncomingFileValue(
  organizationId: string,
  incoming: unknown,
  existing: string | null,
): string | null {
  if (incoming === null) return null;
  if (typeof incoming !== 'string' || !incoming) return existing;
  if (!incoming.startsWith('/files/')) return incoming;
  const claim = verifyFileToken(incoming.slice('/files/'.length));
  if (claim && claim.organizationId === organizationId) {
    return claim.relativeKey;
  }
  return existing;
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

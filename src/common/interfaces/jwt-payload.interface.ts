import { Role } from '@prisma/client';

// Shape signed into the access token. `sub` (not `id`) follows JWT
// convention. Deliberately minimal — role/organizationId are only ever
// used as a hint; JwtAccessStrategy re-fetches the real user row from the
// DB rather than trusting these claims for authorization decisions (see
// that file for why).
export interface JwtPayload {
  sub: string;
  organizationId: string;
  role: Role;
  // Random per-issuance ID. Without this, two tokens signed for the same
  // user within the same second (iat has second granularity) are
  // byte-for-byte identical — harmless for authorization, but it means
  // "issue a new token" isn't actually observably distinct from "same
  // token again," which matters for audit/traceability and surfaced as
  // real e2e test flakiness (rapid login->refresh in the same second).
  jti: string;
}

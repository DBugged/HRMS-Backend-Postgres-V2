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
}

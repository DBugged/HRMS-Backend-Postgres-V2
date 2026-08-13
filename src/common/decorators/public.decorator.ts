import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marks a route as exempt from the global JwtAuthGuard (register/login/
// refresh don't have a token to check yet). Applied per-route rather than
// per-controller so a controller can mix public and protected endpoints.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

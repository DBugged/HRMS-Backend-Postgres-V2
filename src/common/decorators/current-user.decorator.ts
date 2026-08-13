import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@prisma/client';

// Populated by JwtAuthGuard -> JwtAccessStrategy.validate(), which returns
// the freshly-fetched DB row (password field excluded via destructuring).
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Omit<User, 'password'> => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: Omit<User, 'password'> }>();
    return request.user;
  },
);

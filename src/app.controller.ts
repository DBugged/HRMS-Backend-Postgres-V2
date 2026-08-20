// Purpose: Exposes the root health-check endpoint used by load balancers and uptime monitors.
// Responsibilities: Delegates to AppService; contains no business logic itself.
// Important: The root route is @Public() — predates the global JwtAuthGuard and intentionally stays unauthenticated.
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Health check — must stay reachable without a token (load balancers /
  // uptime monitors don't have one). The global JwtAuthGuard requires
  // @Public() explicitly on every route that's meant to be unauthenticated;
  // this was the one route that predates that guard being added and had
  // been silently relying on default-allow before RBAC work started.
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}

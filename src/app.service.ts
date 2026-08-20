// Purpose: Trivial default service scaffolded by Nest CLI, still used for the root health-check route.
// Responsibilities: Owns nothing beyond a static greeting string; no business logic lives here.
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}

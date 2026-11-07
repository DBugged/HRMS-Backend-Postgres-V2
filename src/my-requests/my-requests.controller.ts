// Purpose: GET /my-requests (everything the caller asked for) and POST /my-requests/:kind/:id/cancel (withdraw one). Any signed-in
//   role: both are always about the caller's own records.
import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MyRequestsService } from './my-requests.service';

type Caller = Omit<User, 'password'>;

@ApiTags('my-requests')
@ApiBearerAuth('access-token')
@Controller('my-requests')
export class MyRequestsController {
  constructor(private readonly svc: MyRequestsService) {}

  @Get() list(@CurrentUser() u: Caller) { return this.svc.list(u); }
  @Post(':kind/:id/cancel') cancel(@CurrentUser() u: Caller, @Param('kind') kind: string, @Param('id') id: string) { return this.svc.cancel(u, kind, id); }
}

// Purpose: GET /platform-brand - the product name and logo, public so the sign-in screens (before anyone is signed in) can show them.
import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformBrandService } from './platform-brand.service';

@ApiTags('platform-brand')
@Public()
@Controller('platform-brand')
export class PlatformBrandController {
  constructor(private readonly brand: PlatformBrandService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  get() { return this.brand.get(); }
}

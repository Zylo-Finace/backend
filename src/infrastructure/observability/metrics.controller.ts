import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../core/decorators/public.decorator';
import { SkipResponseEnvelope } from '../../core/decorators/skip-response-envelope.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Deliberately unversioned and outside the `/v1` tree — it is an operational
 * interface, not part of the customer-facing API contract.
 *
 * **Deployment note:** this route must not be exposed publicly. Nginx blocks it
 * for anything outside the private network (see `docker/nginx/`); in Kubernetes,
 * bind it to the metrics port and keep it off the ingress.
 */
// Prometheus scrapes without credentials; network-level restriction (see the
// nginx config) is what keeps this endpoint private, not authentication.
@Public()
@ApiExcludeController()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @SkipResponseEnvelope()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}

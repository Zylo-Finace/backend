import { Global, Module } from '@nestjs/common';

import { LoggerModule } from './logger.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Cross-cutting observability: structured logs, metrics, and the tracing SDK
 * (started out-of-band in `main.ts`, see `tracing.ts` for why).
 *
 * Global because virtually every module records something; making each one import
 * it explicitly would be ceremony without benefit.
 */
@Global()
@Module({
  imports: [LoggerModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [LoggerModule, MetricsService],
})
export class ObservabilityModule {}

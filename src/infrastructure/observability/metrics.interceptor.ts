import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

import { MetricsService } from './metrics.service';

/**
 * Records the RED metrics (Rate, Errors, Duration) for every HTTP request.
 *
 * Uses Express' *route pattern* rather than `req.url`, so `/v1/contacts/abc-123`
 * and `/v1/contacts/def-456` collapse into one series. Recording raw URLs here
 * would create unbounded label cardinality — one time series per contact id.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const method = request.method;
    const stopTimer = this.metrics.httpRequestDuration.startTimer();
    this.metrics.httpRequestsInFlight.inc({ method });

    return next.handle().pipe(
      finalize(() => {
        this.metrics.httpRequestsInFlight.dec({ method });

        const labels = {
          method,
          route: this.resolveRoute(request, context),
          status: String(response.statusCode),
        };

        stopTimer(labels);
        this.metrics.httpRequestsTotal.inc(labels);
      }),
    );
  }

  private resolveRoute(request: Request, context: ExecutionContext): string {
    // Express fills `route.path` with the matched pattern, e.g. `/contacts/:id`.
    const routePath = (request as unknown as { route?: { path?: string } }).route?.path;
    if (routePath) {
      const base = (request.baseUrl || '').replace(/\/$/, '');
      return `${base}${routePath}` || routePath;
    }
    // No matched route (404s, or a guard rejecting before routing). Bucketing them
    // under a constant keeps a scanner probing random paths from exploding the registry.
    return `unmatched:${context.getClass?.()?.name ?? 'none'}`;
  }
}

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { RequestContext } from '../context/request-context';
import { SKIP_RESPONSE_ENVELOPE } from '../decorators/skip-response-envelope.decorator';
import type { ApiSuccessResponse } from '../dto/api-response.dto';

/** Marker a handler may return to attach `meta` alongside `data`. */
export interface WithMeta<T> {
  readonly data: T;
  readonly meta: Record<string, unknown>;
}

const isWithMeta = <T>(value: unknown): value is WithMeta<T> =>
  typeof value === 'object' &&
  value !== null &&
  'data' in value &&
  'meta' in value &&
  Object.keys(value).length === 2;

/**
 * Wraps every successful handler result in the standard envelope.
 *
 * Handlers stay clean — they return a DTO, or `{ data, meta }` when they have
 * pagination metadata. Endpoints that must emit a raw body (Meta's webhook
 * verification echo, file streams, Prometheus metrics) opt out with
 * `@SkipResponseEnvelope()`.
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload): ApiSuccessResponse<unknown> => {
        const { data, meta } = isWithMeta(payload)
          ? { data: payload.data, meta: payload.meta }
          : { data: payload, meta: undefined };

        return {
          success: true,
          data: data ?? null,
          ...(meta ? { meta } : {}),
          requestId: RequestContext.requestId ?? 'unknown',
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}

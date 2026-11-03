import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { HttpHeader } from '../constants/http-header.constants';
import { ActorType, RequestContext } from './request-context';

/** Accept an inbound id only if it looks sane — never echo unbounded client input. */
const SAFE_ID = /^[A-Za-z0-9._~-]{8,128}$/;

/**
 * Opens the {@link RequestContext} for the lifetime of an HTTP request.
 *
 * Mounted first, before any guard or interceptor, so that *everything* downstream —
 * including the exception filter that runs when a guard rejects — has a request id
 * to log and return.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // pino-http's middleware runs ahead of this one and has already minted `req.id`
    // (adopting any valid inbound header). Reusing it keeps the log records, the
    // response header and the trace pointing at the same identifier.
    const requestId =
      pickId(req.headers[HttpHeader.RequestId]) ??
      pickId(asString((req as unknown as { id?: unknown }).id)) ??
      randomUUID();
    // A correlation id links this request to the chain that produced it: an
    // upstream service, or the queue job that will be enqueued from here.
    const correlationId = pickId(req.headers[HttpHeader.CorrelationId]) ?? requestId;

    res.setHeader(HttpHeader.RequestId, requestId);
    res.setHeader(HttpHeader.CorrelationId, correlationId);

    RequestContext.run(
      {
        requestId,
        correlationId,
        actorType: ActorType.Anonymous,
        ip: req.ip,
        userAgent: truncate(req.headers['user-agent'], 256),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        idempotencyKey: pickId(req.headers[HttpHeader.IdempotencyKey]),
      },
      () => next(),
    );
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pickId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && SAFE_ID.test(candidate) ? candidate : undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

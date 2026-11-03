import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

import { REQUEST_TIMEOUT_MS } from '../decorators/request-timeout.decorator';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';

/** Ceiling for any HTTP handler that does not opt out. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Bounds how long a single request may occupy a worker.
 *
 * Without this, one stuck upstream call (Meta's Graph API, an AI provider) holds a
 * connection open until the client or the proxy gives up, and under load those
 * sockets accumulate until the event loop is saturated by work nobody is waiting
 * for. Failing fast at a known deadline keeps the failure bounded and observable.
 *
 * Note this cancels the *response*, not the underlying work — anything that must
 * outlive the request (sending a WhatsApp message) belongs on a queue, not here.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const configured = this.reflector.getAllAndOverride<number | null>(REQUEST_TIMEOUT_MS, [
      context.getHandler(),
      context.getClass(),
    ]);

    // `null` is an explicit opt-out for streaming / long-poll endpoints.
    if (configured === null) {
      return next.handle();
    }

    const ms = configured ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return next.handle().pipe(
      timeout({ each: ms }),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new AppException(ErrorCode.REQUEST_TIMEOUT, {
                message: `Request exceeded the ${ms}ms processing budget`,
                details: { timeoutMs: ms },
                cause: error,
              })
            : error,
        ),
      ),
    );
  }
}

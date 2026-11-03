import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { HttpHeader } from '../constants/http-header.constants';
import { RequestContext } from '../context/request-context';
import type { ApiErrorResponse } from '../dto/api-response.dto';
import { AppException } from '../errors/app.exception';
import { ErrorCode, isRetryableErrorCode } from '../errors/error-code.enum';
import { ExceptionTranslatorRegistry } from '../errors/exception-translator';

/**
 * The single exit point for every failure in the HTTP layer.
 *
 * Responsibilities, in order:
 *  1. Normalise *any* thrown value into an {@link AppException}.
 *  2. Log it once, at the right level, with full context — 5xx as `error` (pages
 *     someone), 4xx as `warn`/`debug` (caller's problem, not an incident).
 *  3. Emit the standard error envelope, redacted in production.
 *
 * Because it never rethrows, an error can't escape into Express' default handler
 * and leak a stack trace to the client.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly translators: ExceptionTranslatorRegistry,
  ) {
    // `PinoLogger` is transient-scoped, so each consumer gets its own instance and
    // `setContext` is safe. Preferred over `@InjectPinoLogger(Name)`: that
    // decorator registers its provider when the class is first imported, so it
    // resolves only if the class happens to be loaded before nestjs-pino's module
    // is configured. That makes DI depend on import order — reordering an import
    // statement would break the app at boot.
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // Non-HTTP contexts (queue workers, websockets) have their own error handling;
    // rethrow so BullMQ can count the attempt and apply its backoff policy.
    if (host.getType() !== 'http') {
      throw exception;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const normalised = this.normalise(exception);
    const status: HttpStatus = normalised.getStatus();

    this.log(normalised, exception, request, status);

    if (response.headersSent) {
      // A stream already started writing; we can only abort the socket.
      response.destroy();
      return;
    }

    if (normalised.retryAfterSeconds !== undefined) {
      response.setHeader(HttpHeader.RetryAfter, String(normalised.retryAfterSeconds));
    }

    response.status(status).json(this.toEnvelope(normalised, status));
  }

  /** Coerces anything thrown anywhere into a well-formed AppException. */
  private normalise(exception: unknown): AppException {
    if (exception instanceof AppException) {
      return exception;
    }

    const translated = this.translators.translate(exception);
    if (translated) return translated;

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Error && exception.name === 'TimeoutError') {
      return new AppException(ErrorCode.REQUEST_TIMEOUT, {
        message: 'The request took too long to process',
        cause: exception,
      });
    }

    return new AppException(ErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred',
      cause: exception,
    });
  }

  /**
   * Maps Nest's built-in exceptions — most importantly `ValidationPipe`'s
   * `BadRequestException`, whose payload carries the field-level violations.
   */
  private fromHttpException(exception: HttpException): AppException {
    const status: HttpStatus = exception.getStatus();
    const payload = exception.getResponse();

    let message = exception.message;
    let details: Record<string, unknown> | undefined;

    if (typeof payload === 'object' && payload !== null) {
      const body = payload as Record<string, unknown>;

      // Already our shape (thrown by a nested AppException that lost its type).
      if (typeof body.code === 'string' && typeof body.message === 'string') {
        return new AppException(body.code as ErrorCode, {
          message: body.message,
          status,
          details: body.details as Record<string, unknown> | undefined,
          cause: exception,
        });
      }

      if (typeof body.message === 'string') {
        message = body.message;
      } else if (Array.isArray(body.message)) {
        // ValidationPipe: string[] of constraint messages.
        details = { violations: body.message };
        message = 'Request validation failed';
        return new AppException(ErrorCode.VALIDATION_FAILED, {
          message,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          details,
          cause: exception,
        });
      }
    } else if (typeof payload === 'string') {
      message = payload;
    }

    return new AppException(this.codeForStatus(status), { message, status, cause: exception });
  }

  private codeForStatus(status: HttpStatus): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.ROUTE_NOT_FOUND;
      case HttpStatus.METHOD_NOT_ALLOWED:
        return ErrorCode.METHOD_NOT_ALLOWED;
      case HttpStatus.CONFLICT:
        return ErrorCode.RESOURCE_CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.REQUEST_TIMEOUT:
        return ErrorCode.REQUEST_TIMEOUT;
      case HttpStatus.NOT_IMPLEMENTED:
        return ErrorCode.NOT_IMPLEMENTED;
      case HttpStatus.BAD_GATEWAY:
        return ErrorCode.UPSTREAM_ERROR;
      case HttpStatus.GATEWAY_TIMEOUT:
        return ErrorCode.UPSTREAM_TIMEOUT;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? ErrorCode.INTERNAL_ERROR
          : ErrorCode.VALIDATION_FAILED;
    }
  }

  private log(error: AppException, original: unknown, request: Request, status: HttpStatus): void {
    const context = RequestContext.get();
    const payload = {
      err: original instanceof Error ? original : new Error(String(original)),
      errorCode: error.code,
      statusCode: status,
      method: request.method,
      path: request.originalUrl.split('?')[0],
      tenantId: context?.tenantId,
      userId: context?.userId,
      actorType: context?.actorType,
      durationMs: context ? Date.now() - context.startedAt : undefined,
      details: error.details,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(payload, error.message);
    } else if (status === HttpStatus.TOO_MANY_REQUESTS || status === HttpStatus.UNAUTHORIZED) {
      // High-volume and usually benign; keep them out of the warning stream but
      // retain them for abuse analysis.
      this.logger.debug(payload, error.message);
    } else {
      this.logger.warn(payload, error.message);
    }
  }

  private toEnvelope(error: AppException, status: HttpStatus): ApiErrorResponse {
    const leaksInternals = status >= HttpStatus.INTERNAL_SERVER_ERROR;
    const hideMessage = leaksInternals && this.config.app.isProduction;

    return {
      success: false,
      error: {
        code: error.code,
        // A 500's message may embed a driver string, a query fragment, or a
        // connection URI. Outside development we return a fixed sentence and
        // leave the specifics in the logs, joined by requestId.
        message: hideMessage ? 'An unexpected error occurred' : error.message,
        ...(error.details && !hideMessage ? { details: error.details } : {}),
        retryable: error.retryable || isRetryableErrorCode(error.code),
      },
      requestId: RequestContext.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
  }
}

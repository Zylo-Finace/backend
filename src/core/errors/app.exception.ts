import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode, isRetryableErrorCode } from './error-code.enum';

/** Structured, non-sensitive detail attached to an error (field violations, upstream ids, …). */
export type ErrorDetails = Record<string, unknown>;

export interface AppExceptionOptions {
  /** Human-readable, safe to show to an end user. Never interpolate secrets. */
  readonly message?: string;
  /** HTTP status. Defaults to the canonical status for the code. */
  readonly status?: HttpStatus;
  /** Structured context returned to the client. Must be free of PII/secrets. */
  readonly details?: ErrorDetails;
  /** Underlying error. Logged, never serialised to the client. */
  readonly cause?: unknown;
  /** Overrides the catalogue's retryability for this instance. */
  readonly retryable?: boolean;
  /** Seconds the client should wait before retrying — becomes the `Retry-After` header. */
  readonly retryAfterSeconds?: number;
}

/**
 * Canonical HTTP status per error code.
 *
 * Keeping this mapping in one place means a controller never picks a status by
 * hand, so the same failure always crosses the wire the same way.
 */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, HttpStatus>> = {
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.NOT_IMPLEMENTED]: HttpStatus.NOT_IMPLEMENTED,
  [ErrorCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.REQUEST_TIMEOUT]: HttpStatus.REQUEST_TIMEOUT,
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.MALFORMED_JSON]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PAYLOAD_TOO_LARGE]: HttpStatus.PAYLOAD_TOO_LARGE,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  [ErrorCode.ROUTE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.METHOD_NOT_ALLOWED]: HttpStatus.METHOD_NOT_ALLOWED,

  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_CREDENTIALS]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_INVALID]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_REVOKED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.REFRESH_TOKEN_REUSE_DETECTED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.SESSION_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.EMAIL_NOT_VERIFIED]: HttpStatus.FORBIDDEN,
  [ErrorCode.TWO_FACTOR_REQUIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TWO_FACTOR_INVALID]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.ACCOUNT_LOCKED]: HttpStatus.FORBIDDEN,
  [ErrorCode.ACCOUNT_SUSPENDED]: HttpStatus.FORBIDDEN,
  [ErrorCode.API_KEY_INVALID]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.API_KEY_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.API_KEY_REVOKED]: HttpStatus.UNAUTHORIZED,

  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: HttpStatus.FORBIDDEN,
  [ErrorCode.ROLE_REQUIRED]: HttpStatus.FORBIDDEN,

  [ErrorCode.TENANT_NOT_RESOLVED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.TENANT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.TENANT_SUSPENDED]: HttpStatus.FORBIDDEN,
  [ErrorCode.TENANT_MISMATCH]: HttpStatus.FORBIDDEN,
  [ErrorCode.CROSS_TENANT_ACCESS_DENIED]: HttpStatus.FORBIDDEN,

  [ErrorCode.RESOURCE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.RESOURCE_ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [ErrorCode.RESOURCE_CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.RESOURCE_GONE]: HttpStatus.GONE,
  [ErrorCode.OPTIMISTIC_LOCK_FAILED]: HttpStatus.CONFLICT,
  [ErrorCode.PRECONDITION_FAILED]: HttpStatus.PRECONDITION_FAILED,
  [ErrorCode.INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,

  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.IDEMPOTENCY_KEY_CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS]: HttpStatus.CONFLICT,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.QUOTA_EXCEEDED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.CONCURRENCY_LIMIT_EXCEEDED]: HttpStatus.TOO_MANY_REQUESTS,

  [ErrorCode.BILLING_PLAN_LIMIT_REACHED]: HttpStatus.PAYMENT_REQUIRED,
  [ErrorCode.SUBSCRIPTION_INACTIVE]: HttpStatus.PAYMENT_REQUIRED,
  [ErrorCode.INSUFFICIENT_BALANCE]: HttpStatus.PAYMENT_REQUIRED,
  [ErrorCode.FEATURE_NOT_AVAILABLE_ON_PLAN]: HttpStatus.FORBIDDEN,

  [ErrorCode.PAYOUT_DUPLICATE_REFERENCE]: HttpStatus.CONFLICT,
  [ErrorCode.PAYOUT_REJECTED]: HttpStatus.UNPROCESSABLE_ENTITY,
  // 202: the request was accepted and the money is held, but the outcome is
  // pending a human. Reporting a 5xx would invite a client retry, which is the
  // one thing that must not happen while the first attempt's fate is unknown.
  [ErrorCode.PAYOUT_UNKNOWN_OUTCOME]: HttpStatus.ACCEPTED,
  [ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED]: HttpStatus.UNPROCESSABLE_ENTITY,

  [ErrorCode.BILL_PRODUCT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.BILL_AMOUNT_NOT_ALLOWED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.BILL_CUSTOMER_INVALID]: HttpStatus.UNPROCESSABLE_ENTITY,
  // Ours to fix, not the caller's — a 4xx would tell them to change a request
  // that was perfectly valid.
  [ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.BILL_ORDER_REJECTED]: HttpStatus.UNPROCESSABLE_ENTITY,
  // 202, for the same reason as PAYOUT_UNKNOWN_OUTCOME: a 5xx invites the retry
  // that must not happen while the first attempt's fate is unknown.
  [ErrorCode.BILL_ORDER_UNKNOWN_OUTCOME]: HttpStatus.ACCEPTED,

  [ErrorCode.WHATSAPP_API_ERROR]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.WHATSAPP_RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.WHATSAPP_TOKEN_INVALID]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WHATSAPP_TEMPLATE_NOT_APPROVED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WHATSAPP_TEMPLATE_PARAM_MISMATCH]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WHATSAPP_RECIPIENT_INVALID]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WHATSAPP_MEDIA_TOO_LARGE]: HttpStatus.PAYLOAD_TOO_LARGE,
  [ErrorCode.WHATSAPP_MEDIA_UNSUPPORTED]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.WEBHOOK_VERIFICATION_FAILED]: HttpStatus.FORBIDDEN,

  [ErrorCode.UPSTREAM_ERROR]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.UPSTREAM_TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [ErrorCode.CIRCUIT_OPEN]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.DATABASE_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.CACHE_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.QUEUE_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.STORAGE_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.AI_PROVIDER_ERROR]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.AI_ALL_PROVIDERS_FAILED]: HttpStatus.SERVICE_UNAVAILABLE,
};

export function statusForErrorCode(code: ErrorCode): HttpStatus {
  return STATUS_BY_CODE[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * The one exception type first-party code throws.
 *
 * Extends `HttpException` so Nest's built-in machinery (and any third-party
 * filter) still understands it, while carrying the stable {@link ErrorCode},
 * retry semantics and structured details that the platform's envelope needs.
 *
 * @example
 * throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
 *   message: 'Contact not found',
 *   details: { resource: 'contact', id },
 * });
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: AppExceptionOptions = {}) {
    const status = options.status ?? statusForErrorCode(code);
    const message = options.message ?? defaultMessageFor(code);

    super({ code, message, details: options.details }, status, { cause: options.cause });

    this.name = 'AppException';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? isRetryableErrorCode(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** True when this represents a caller mistake rather than a platform fault. */
  get isClientError(): boolean {
    return this.getStatus() >= 400 && this.getStatus() < 500;
  }

  static notFound(resource: string, id?: string): AppException {
    return new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
      message: `${resource} not found`,
      details: id === undefined ? { resource } : { resource, id },
    });
  }

  static conflict(message: string, details?: ErrorDetails): AppException {
    return new AppException(ErrorCode.RESOURCE_CONFLICT, { message, details });
  }

  static forbidden(message = 'You do not have access to this resource'): AppException {
    return new AppException(ErrorCode.FORBIDDEN, { message });
  }

  static unauthenticated(message = 'Authentication required'): AppException {
    return new AppException(ErrorCode.UNAUTHENTICATED, { message });
  }

  static validation(message: string, details?: ErrorDetails): AppException {
    return new AppException(ErrorCode.VALIDATION_FAILED, { message, details });
  }

  static internal(message = 'An unexpected error occurred', cause?: unknown): AppException {
    return new AppException(ErrorCode.INTERNAL_ERROR, { message, cause });
  }
}

/** Fallback copy so a thrown code always has a presentable message. */
function defaultMessageFor(code: ErrorCode): string {
  return code
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^./, (char) => char.toUpperCase());
}

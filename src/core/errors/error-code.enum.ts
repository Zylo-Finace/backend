/**
 * Stable, machine-readable error catalogue.
 *
 * Contract with API consumers: they branch on `error.code`, never on the HTTP
 * status or the human-readable message. Codes are therefore **append-only** —
 * renaming one is a breaking API change. Messages may be reworded freely.
 *
 * Namespacing convention: `DOMAIN_SPECIFIC_REASON`.
 */
export enum ErrorCode {
  // -- Generic / transport (1xx) --------------------------------------------
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  MALFORMED_JSON = 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',

  // -- Authentication (2xx) -------------------------------------------------
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  REFRESH_TOKEN_REUSE_DETECTED = 'REFRESH_TOKEN_REUSE_DETECTED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED',
  TWO_FACTOR_INVALID = 'TWO_FACTOR_INVALID',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  API_KEY_INVALID = 'API_KEY_INVALID',
  API_KEY_EXPIRED = 'API_KEY_EXPIRED',
  API_KEY_REVOKED = 'API_KEY_REVOKED',

  // -- Authorization (3xx) --------------------------------------------------
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  ROLE_REQUIRED = 'ROLE_REQUIRED',

  // -- Tenancy (4xx) --------------------------------------------------------
  TENANT_NOT_RESOLVED = 'TENANT_NOT_RESOLVED',
  TENANT_NOT_FOUND = 'TENANT_NOT_FOUND',
  TENANT_SUSPENDED = 'TENANT_SUSPENDED',
  TENANT_MISMATCH = 'TENANT_MISMATCH',
  CROSS_TENANT_ACCESS_DENIED = 'CROSS_TENANT_ACCESS_DENIED',

  // -- Resources (5xx) ------------------------------------------------------
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS = 'RESOURCE_ALREADY_EXISTS',
  RESOURCE_CONFLICT = 'RESOURCE_CONFLICT',
  RESOURCE_GONE = 'RESOURCE_GONE',
  OPTIMISTIC_LOCK_FAILED = 'OPTIMISTIC_LOCK_FAILED',
  PRECONDITION_FAILED = 'PRECONDITION_FAILED',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',

  // -- Idempotency & rate limiting (6xx) ------------------------------------
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_CONFLICT = 'IDEMPOTENCY_KEY_CONFLICT',
  IDEMPOTENT_REQUEST_IN_PROGRESS = 'IDEMPOTENT_REQUEST_IN_PROGRESS',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  CONCURRENCY_LIMIT_EXCEEDED = 'CONCURRENCY_LIMIT_EXCEEDED',

  // -- Billing (7xx) --------------------------------------------------------
  BILLING_PLAN_LIMIT_REACHED = 'BILLING_PLAN_LIMIT_REACHED',
  SUBSCRIPTION_INACTIVE = 'SUBSCRIPTION_INACTIVE',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  FEATURE_NOT_AVAILABLE_ON_PLAN = 'FEATURE_NOT_AVAILABLE_ON_PLAN',

  // -- Payouts / outward transfers (75x) ------------------------------------
  /** The provider has already accepted a transfer under this reference. */
  PAYOUT_DUPLICATE_REFERENCE = 'PAYOUT_DUPLICATE_REFERENCE',
  /** The provider refused the instruction outright. No money moved. */
  PAYOUT_REJECTED = 'PAYOUT_REJECTED',
  /**
   * The outcome could not be determined and a human must decide. The customer's
   * funds stay held — never released on a guess, because the transfer may have
   * gone through.
   */
  PAYOUT_UNKNOWN_OUTCOME = 'PAYOUT_UNKNOWN_OUTCOME',
  /** Amount is outside the configured per-transfer bounds. */
  PAYOUT_AMOUNT_NOT_ALLOWED = 'PAYOUT_AMOUNT_NOT_ALLOWED',

  // -- Bill payments / VTU (78x) --------------------------------------------
  /** No such data plan, cable package, disco or betting company in the catalogue. */
  BILL_PRODUCT_NOT_FOUND = 'BILL_PRODUCT_NOT_FOUND',
  /** Amount is outside the bounds the upstream product accepts. */
  BILL_AMOUNT_NOT_ALLOWED = 'BILL_AMOUNT_NOT_ALLOWED',
  /** Meter, smartcard or betting customer id did not resolve to an account. */
  BILL_CUSTOMER_INVALID = 'BILL_CUSTOMER_INVALID',
  /**
   * Our reseller float at the upstream provider cannot cover the order. A
   * platform problem, not the customer's — their wallet is untouched.
   */
  BILL_PROVIDER_FLOAT_EXHAUSTED = 'BILL_PROVIDER_FLOAT_EXHAUSTED',
  /** The provider refused the order outright. Nothing was delivered. */
  BILL_ORDER_REJECTED = 'BILL_ORDER_REJECTED',
  /**
   * The order's fate could not be determined. It may still be delivered, so it
   * must be reconciled against the provider rather than assumed failed.
   */
  BILL_ORDER_UNKNOWN_OUTCOME = 'BILL_ORDER_UNKNOWN_OUTCOME',

  // -- WhatsApp / Meta Cloud API (8xx) --------------------------------------
  WHATSAPP_API_ERROR = 'WHATSAPP_API_ERROR',
  WHATSAPP_RATE_LIMITED = 'WHATSAPP_RATE_LIMITED',
  WHATSAPP_TOKEN_INVALID = 'WHATSAPP_TOKEN_INVALID',
  WHATSAPP_NUMBER_NOT_REGISTERED = 'WHATSAPP_NUMBER_NOT_REGISTERED',
  WHATSAPP_TEMPLATE_NOT_APPROVED = 'WHATSAPP_TEMPLATE_NOT_APPROVED',
  WHATSAPP_TEMPLATE_PARAM_MISMATCH = 'WHATSAPP_TEMPLATE_PARAM_MISMATCH',
  WHATSAPP_OUTSIDE_SERVICE_WINDOW = 'WHATSAPP_OUTSIDE_SERVICE_WINDOW',
  WHATSAPP_RECIPIENT_INVALID = 'WHATSAPP_RECIPIENT_INVALID',
  WHATSAPP_MEDIA_TOO_LARGE = 'WHATSAPP_MEDIA_TOO_LARGE',
  WHATSAPP_MEDIA_UNSUPPORTED = 'WHATSAPP_MEDIA_UNSUPPORTED',
  WEBHOOK_SIGNATURE_INVALID = 'WEBHOOK_SIGNATURE_INVALID',
  WEBHOOK_VERIFICATION_FAILED = 'WEBHOOK_VERIFICATION_FAILED',

  // -- Upstream / infrastructure (9xx) --------------------------------------
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  DATABASE_ERROR = 'DATABASE_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  QUEUE_ERROR = 'QUEUE_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  AI_PROVIDER_ERROR = 'AI_PROVIDER_ERROR',
  AI_ALL_PROVIDERS_FAILED = 'AI_ALL_PROVIDERS_FAILED',
}

/**
 * Whether a client may safely retry the same request.
 * Surfaced as the `retryable` flag in the error envelope so SDKs can implement
 * backoff without maintaining their own status-code table.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.REQUEST_TIMEOUT,
  ErrorCode.RATE_LIMIT_EXCEEDED,
  ErrorCode.CONCURRENCY_LIMIT_EXCEEDED,
  ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
  ErrorCode.OPTIMISTIC_LOCK_FAILED,
  ErrorCode.UPSTREAM_ERROR,
  ErrorCode.UPSTREAM_TIMEOUT,
  ErrorCode.CIRCUIT_OPEN,
  ErrorCode.DATABASE_ERROR,
  ErrorCode.CACHE_ERROR,
  ErrorCode.QUEUE_ERROR,
  ErrorCode.STORAGE_ERROR,
  ErrorCode.WHATSAPP_RATE_LIMITED,
  ErrorCode.AI_PROVIDER_ERROR,
  // Transient by nature: the float is topped up out of band, and the identical
  // request succeeds once it is.
  ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED,
]);

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

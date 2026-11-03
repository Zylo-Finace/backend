/**
 * Header names used across the platform.
 *
 * Lowercase because Node normalises inbound header keys to lowercase; using these
 * constants for `res.setHeader` too keeps request/response naming symmetrical.
 */
export const HttpHeader = {
  RequestId: 'x-request-id',
  CorrelationId: 'x-correlation-id',
  IdempotencyKey: 'idempotency-key',
  ApiKey: 'x-api-key',
  TenantId: 'x-tenant-id',
  ApiVersion: 'x-api-version',

  Authorization: 'authorization',
  RetryAfter: 'retry-after',

  RateLimitLimit: 'x-ratelimit-limit',
  RateLimitRemaining: 'x-ratelimit-remaining',
  RateLimitReset: 'x-ratelimit-reset',

  /** Meta signs every webhook body with the app secret; verified in the WhatsApp module. */
  MetaSignature: 'x-hub-signature-256',
} as const;

export type HttpHeaderName = (typeof HttpHeader)[keyof typeof HttpHeader];

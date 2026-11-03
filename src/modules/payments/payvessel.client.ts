import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

/** Which PayVessel surface a call is addressed to. */
export enum PayVesselApi {
  /** Collections: reserved accounts, transactions, transfers. Root host. */
  Payments = 'payments',
  /** Identity verification. Served from a distinct `/kyc` prefix. */
  Kyc = 'kyc',
}

export interface PayVesselRequest {
  method: 'GET' | 'POST';
  api: PayVesselApi;
  /** Path relative to the chosen base URL, leading slash included. */
  path: string;
  body?: unknown;
  /**
   * Status codes to return to the caller instead of throwing.
   *
   * Used for responses that are *answers*, not failures: a KYC `402` means "your
   * PayVessel wallet is empty", which the KYC service records against the
   * verification attempt and surfaces to operations. Treating it as a generic
   * upstream error would lose that.
   */
  allowStatuses?: number[];
}

export interface PayVesselResponse<T> {
  status: number;
  body: T;
}

/**
 * One place where PayVessel's authentication and transport concerns live.
 *
 * ## Why a client separate from the provider
 *
 * PayVessel is two products behind one credential pair: reserved accounts
 * (`/pms/...`) and identity verification (`/kyc/...`). They have different base
 * URLs, different response envelopes and different failure modes, but identical
 * auth, timeout, metric and error-mapping needs. Splitting the shared half out
 * means the account adapter and the KYC adapter each contain only what is
 * genuinely specific to them.
 *
 * ## Authentication
 *
 * Two headers, `api-key` and `api-secret`, on every request. There is no
 * signature, no nonce and no expiry: possession of the secret *is* the
 * authorisation, and it grants unrestricted access to the account. It is
 * therefore read from config only, never logged, and never echoed into an error
 * — including the `details` we let through to callers.
 */
@Injectable()
export class PayVesselClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(PayVesselClient.name);
  }

  /** True when credentials are present. Callers fail closed rather than 401. */
  get isConfigured(): boolean {
    const { apiKey, apiSecret } = this.config.payments.payvessel;
    return Boolean(apiKey && apiSecret);
  }

  get businessId(): string {
    return this.config.payments.payvessel.businessId;
  }

  async request<T>(request: PayVesselRequest): Promise<PayVesselResponse<T>> {
    const settings = this.config.payments.payvessel;

    if (!this.isConfigured) {
      // Fail before the round trip. An unauthenticated call returns a 401 that
      // reads like a provider outage, which sends the on-call engineer to the
      // wrong place entirely.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'The payment provider is not configured',
        details: { providerMessage: 'PAYVESSEL_API_KEY / PAYVESSEL_API_SECRET are unset' },
      });
    }

    const base = request.api === PayVesselApi.Kyc ? settings.kycBaseUrl : settings.baseUrl;
    const url = `${base}${request.path}`;
    // Path only — never the query string or body, either of which can carry a
    // BVN. Cardinality stays bounded because ids are stripped.
    const operation = `payvessel${request.path.replace(/[^a-z]+/gi, '_').toLowerCase()}`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          'api-key': settings.apiKey,
          'api-secret': settings.apiSecret,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // No deadline means one degraded provider eventually holds every request
        // worker open. The budget is deliberately shorter than the inbound one.
        signal: AbortSignal.timeout(this.config.payments.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'PayVessel could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const body = (await response.json().catch(() => null)) as T | null;

    if (response.ok || request.allowStatuses?.includes(response.status)) {
      this.metrics.whatsappApiCallsTotal.inc({
        operation,
        status: response.ok ? 'success' : String(response.status),
      });
      return { status: response.status, body: (body ?? {}) as T };
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });

    const providerMessage = describe(body) ?? `HTTP ${response.status}`;

    this.logger.error(
      { status: response.status, path: request.path, providerMessage },
      'PayVessel request failed',
    );

    throw new AppException(ErrorCode.UPSTREAM_ERROR, {
      message: 'PayVessel rejected the request',
      // Safe to surface: it names the offending field (missing BVN, unknown bank
      // code) and is what support needs. The credential lives only in headers.
      details: { providerMessage },
      // 4xx will fail identically on retry; 5xx may not.
      retryable: response.status >= 500,
    });
  }
}

/**
 * Extracts a human-readable reason from whichever error envelope PayVessel used.
 *
 * The two products disagree: account calls return `{status, service, message,
 * errors: {field: [...]}}`, KYC returns `{success, message, details: [...]}`.
 * Rather than make every call site know which it is talking to, both shapes are
 * flattened here into one sentence.
 */
function describe(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof envelope.message === 'string' && envelope.message) parts.push(envelope.message);

  if (envelope.errors && typeof envelope.errors === 'object') {
    for (const [field, messages] of Object.entries(envelope.errors as Record<string, unknown>)) {
      const text = Array.isArray(messages) ? messages.join('; ') : String(messages);
      parts.push(`${field}: ${text}`);
    }
  } else if (Array.isArray(envelope.details)) {
    parts.push(envelope.details.map((detail) => String(detail)).join('; '));
  }

  const message = parts.join(' — ').trim();
  return message.length > 0 ? message.slice(0, 500) : undefined;
}

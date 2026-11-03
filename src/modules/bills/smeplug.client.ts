import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

/** SMEPlug endpoint paths. Named so call sites read as intent, not as URLs. */
export const SP_ENDPOINT = {
  walletBalance: '/account/balance',
  dataPlans: '/data/plans',
  buyData: '/data/purchase',
  buyAirtime: '/airtime/purchase',
  buyAirtimeVtu: '/vtu',
} as const;

/**
 * The envelope most SMEPlug endpoints use.
 *
 * `status` is a boolean, not an HTTP-style code, and it is the *only* reliable
 * success signal: a refused purchase still comes back HTTP 200.
 */
export interface SpEnvelope<T> {
  status?: boolean;
  msg?: string;
  message?: string;
  error?: string | string[];
  data?: T;
}

/**
 * Transport for SMEPlug.
 *
 * ## What this layer absorbs
 *
 * Two things, both of which would otherwise leak into every call site. First,
 * **success and failure share HTTP 200** — a declined purchase is a `200` with
 * `status: false`, so the status code tells you nothing and the boolean tells
 * you everything. Second, the error text arrives under three different keys
 * (`msg`, `message`, `error`, the last of which is sometimes an array) depending
 * on which part of their stack refused.
 *
 * ## Credentials
 *
 * A bearer token, so unlike ClubKonnect the URL is not itself a secret. It is
 * still never logged: the token is only ever placed in the `Authorization`
 * header, and no log line, metric label or exception detail below carries
 * headers.
 */
@Injectable()
export class SmePlugClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(SmePlugClient.name);
  }

  /** True when a secret key is present. Callers fail closed rather than 401. */
  get isConfigured(): boolean {
    return Boolean(this.config.bills.smeplug.secretKey);
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>('POST', path, body);
  }

  /**
   * One outbound call.
   *
   * Returns the parsed body verbatim. Envelope interpretation belongs to the
   * provider, which knows which endpoints wrap their payload in `data` and which
   * return it at the top level — SMEPlug is not consistent about that either.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isConfigured) {
      // Fail before the round trip. An unauthenticated call returns a 401 that
      // reads like a provider outage, sending the on-call engineer to the wrong
      // place entirely.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'The bills provider is not configured',
        details: { providerMessage: 'SMEPLUG_SECRET_KEY is unset' },
        retryable: false,
      });
    }

    const url = `${this.config.bills.smeplug.baseUrl}${path}`;
    const operation = `smeplug${path.replace(/\//g, '_')}`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.bills.smeplug.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // No deadline means one degraded provider eventually holds every request
        // worker open. This is also what makes the fallback to ClubKonnect
        // bounded rather than theoretical.
        signal: AbortSignal.timeout(this.config.bills.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'SMEPlug could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const payload = (await response.json().catch(() => null)) as T | null;

    // SMEPlug often returns business declines as HTTP 400 with the same
    // `{ status: false, msg }` envelope as a soft 200. Treat those as a parsed
    // body so the provider can map them to Failed (and the router can fall back)
    // instead of a generic "rejected the request" transport error.
    if (
      !response.ok &&
      payload &&
      typeof payload === 'object' &&
      (payload as SpEnvelope<unknown>).status === false
    ) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });
      const providerMessage = describe(payload) ?? `HTTP ${response.status}`;
      this.logger.warn(
        { status: response.status, path, providerMessage },
        'SMEPlug declined via HTTP error envelope',
      );
      return payload;
    }

    if (!response.ok || payload === null) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });

      const providerMessage = describe(payload) ?? `HTTP ${response.status}`;
      this.logger.error(
        { status: response.status, path, providerMessage },
        'SMEPlug request failed',
      );

      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: providerMessage.includes('Airtime')
          ? providerMessage
          : 'SMEPlug rejected the request',
        details: { providerMessage },
        // 4xx will fail identically on retry; 5xx may not.
        retryable: response.status >= 500,
      });
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
    return payload;
  }
}

/**
 * Extracts a readable reason from whichever key SMEPlug used.
 *
 * Exported because the provider needs the same flattening for a `200` carrying
 * `status: false`, which the transport layer deliberately does not treat as a
 * failure — that judgement depends on the endpoint.
 */
export function describe(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as SpEnvelope<unknown>;

  const candidates = [envelope.msg, envelope.message];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500);
  }

  if (Array.isArray(envelope.error)) {
    const joined = envelope.error
      .map((entry) => String(entry))
      .join('; ')
      .trim();
    if (joined) return joined.slice(0, 500);
  }
  if (typeof envelope.error === 'string' && envelope.error.trim()) {
    return envelope.error.trim().slice(0, 500);
  }

  return undefined;
}

import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

/** Every Pulse MFB response, success or failure, uses this envelope. */
export interface PulseEnvelope<T> {
  statusCode?: number;
  message?: string;
  /** Present on failures: the HTTP reason phrase, e.g. `"Bad Request"`. */
  error?: string;
  /** Present on validation failures, one entry per offending field. */
  details?: { field?: string; message?: string }[];
  data?: T;
}

/**
 * A Pulse MFB call that did not return a usable body.
 *
 * Deliberately *not* an `AppException`. This client is shared by three adapters
 * that answer to three different domains — an account issuer, a payout provider
 * and a bills provider — and the same HTTP 400 means different things to each:
 * "cannot issue an account", "safe to release the hold", "try the next VTU
 * provider". Choosing an `ErrorCode` here would force one of those three to be
 * wrong. The transport reports *what happened*; each adapter decides what it
 * means.
 */
export class PulseMfbHttpError extends Error {
  constructor(
    /** HTTP status, or 0 when no response was received at all. */
    readonly status: number,
    /** Pulse's own `message`, safe to log and to surface to support. */
    readonly providerMessage: string,
    readonly options: {
      /** True when the request was aborted at our deadline. */
      readonly timedOut: boolean;
      /** The HTTP method, so callers can tell a lost read from a lost write. */
      readonly method: HttpMethod;
      readonly cause?: unknown;
      readonly body?: unknown;
    },
  ) {
    super(providerMessage);
    this.name = 'PulseMfbHttpError';
  }

  /**
   * True when the request definitely never reached Pulse's business logic.
   *
   * The distinction the payout path is built on. A 4xx is an answer: Pulse
   * considered the request and refused it, so nothing was queued. A timeout or a
   * connection failure on a write is *not* an answer — the instruction may well
   * have been accepted and only the response lost.
   */
  get isDefiniteRejection(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }

  /** True when the request was aborted at our deadline. */
  get timedOut(): boolean {
    return this.options.timedOut;
  }

  get method(): HttpMethod {
    return this.options.method;
  }

  /**
   * A write we never got an answer to — the one case that must never be treated
   * as a failure.
   *
   * `status === 0` means no response was received at all: a timeout, a reset, a
   * DNS failure. On a `GET` that is merely a retryable read. On a `POST` it
   * means an instruction may have been accepted and only the acknowledgement
   * lost, and acting as though it failed is how the same money moves twice.
   */
  get isUnknownOutcome(): boolean {
    return this.status === 0 && this.options.method !== 'GET';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

/** Everything under this prefix is the external (API-client) surface. */
export const PULSE_API_PREFIX = '/api/v1/external-api';

/**
 * Transport for Pulse MFB.
 *
 * ## Why one client for three adapters
 *
 * Pulse issues sub-accounts, sends transfers and sells airtime off a single API
 * client: one host, one key pair, one signature scheme, one rate limit. Giving
 * each adapter its own transport would mean three copies of the signing code —
 * and signing is the part that must not drift, because a signature computed over
 * even slightly different bytes fails as a blanket 401 with no indication of
 * which of the three is wrong.
 *
 * ## Request signing
 *
 * Every call carries three headers:
 *
 * ```
 * x-public-key: pk_live_…          identifies the API client
 * x-timestamp:  1703673600000      milliseconds, and Pulse rejects >5 min old
 * x-signature:  <hex>              HMAC-SHA256(privateKey, timestamp+METHOD+path+body)
 * ```
 *
 * The private key never leaves this process — only the digest goes on the wire.
 *
 * **The signed bytes and the sent bytes are the same string.** The body is
 * serialised exactly once, in {@link call}, and that one string is both hashed
 * and posted. Serialising twice is the classic way to produce a signature over
 * `{"a":1,"b":2}` while sending `{"b":2,"a":1}`, which fails every request in a
 * way that looks like a credential problem.
 *
 * **Query strings are not signed.** Their published example signs a bare path,
 * so that is what this reproduces. It is also why the adapters above address
 * every resource by path segment rather than by query parameter — a signing rule
 * that cannot be verified from the documentation is one to avoid depending on.
 */
@Injectable()
export class PulseMfbClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(PulseMfbClient.name);
  }

  /** True when a usable key pair is present. Callers fail closed rather than 401. */
  get isConfigured(): boolean {
    const { publicKey, privateKey } = this.config.pulsemfb;
    return Boolean(publicKey && privateKey);
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>('POST', path, body);
  }

  async patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>('PATCH', path, body);
  }

  /**
   * One outbound call, returning the envelope's `data`.
   *
   * @param path Path *below* {@link PULSE_API_PREFIX}, e.g. `/accounts/prefix`.
   * @throws PulseMfbHttpError on anything that is not a 2xx with a usable body.
   */
  private async call<T>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isConfigured) {
      // Fail before the round trip. An unsigned call comes back 401, which reads
      // like a revoked credential rather than an unset one.
      throw new PulseMfbHttpError(0, 'Pulse MFB is not configured', {
        timedOut: false,
        method,
        body: { providerMessage: 'PULSEMFB_PUBLIC_KEY / PULSEMFB_PRIVATE_KEY are unset' },
      });
    }

    const signedPath = `${PULSE_API_PREFIX}${path}`;
    const url = `${this.config.pulsemfb.baseUrl}${signedPath}`;

    // Serialised once. This exact string is what gets hashed and what gets sent.
    const serialisedBody = body === undefined ? '' : JSON.stringify(body);

    const operation = `pulsemfb${path.replace(/\//g, '_')}`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...this.signatureHeaders(method, signedPath, serialisedBody),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : serialisedBody,
        // No deadline means one degraded provider eventually holds every request
        // worker open — and it is what keeps the failover paths above bounded
        // rather than theoretical.
        signal: AbortSignal.timeout(this.config.pulsemfb.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      this.logger.error(
        { path, method, timedOut, err: cause },
        'Pulse MFB request failed without a response',
      );

      throw new PulseMfbHttpError(0, 'Pulse MFB could not be reached', {
        timedOut,
        method,
        cause,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const payload = (await response.json().catch(() => null)) as PulseEnvelope<T> | null;

    if (!response.ok || payload === null) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });

      const providerMessage = describePulseError(payload) ?? `HTTP ${response.status}`;
      this.logger.error(
        { status: response.status, path, method, providerMessage },
        'Pulse MFB request failed',
      );

      throw new PulseMfbHttpError(response.status, providerMessage, {
        timedOut: false,
        method,
        body: payload,
      });
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });

    // `data` is absent on a handful of their acknowledgement-only responses. An
    // empty object keeps callers from having to null-check a field they will
    // immediately destructure — every one of them validates what it needs.
    return (payload.data ?? {}) as T;
  }

  /**
   * The three authentication headers.
   *
   * `x-api-key` is added when configured. Pulse's documentation describes
   * signature auth, but parts of their published collection authenticate with a
   * bare API key instead; sending both when we hold both means a client
   * provisioned under either scheme works without a code change, and neither
   * header is meaningful to a server that does not check it.
   */
  private signatureHeaders(
    method: HttpMethod,
    signedPath: string,
    serialisedBody: string,
  ): Record<string, string> {
    const { publicKey, privateKey, apiKey } = this.config.pulsemfb;

    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', privateKey)
      .update(`${timestamp}${method}${signedPath}${serialisedBody}`)
      .digest('hex');

    return {
      'x-public-key': publicKey,
      'x-signature': signature,
      'x-timestamp': timestamp,
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    };
  }
}

/**
 * Extracts a readable reason from a Pulse error envelope.
 *
 * Their validation failures put the useful part in `details[]` and leave
 * `message` as a bare `"Validation failed"`, so the field errors are flattened
 * in — a support ticket that says which field was wrong is worth far more than
 * one that says a request was invalid.
 */
export function describePulseError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as PulseEnvelope<unknown>;

  const parts: string[] = [];
  if (typeof envelope.message === 'string' && envelope.message.trim()) {
    parts.push(envelope.message.trim());
  }

  if (Array.isArray(envelope.details)) {
    const fields = envelope.details
      .map((detail) => {
        const field = typeof detail?.field === 'string' ? detail.field : undefined;
        const message = typeof detail?.message === 'string' ? detail.message : undefined;
        if (field && message) return `${field}: ${message}`;
        return message ?? field;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (fields.length > 0) parts.push(fields.join('; '));
  }

  const joined = parts.join(' — ').trim();
  return joined ? joined.slice(0, 500) : undefined;
}

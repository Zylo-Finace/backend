import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { CREDENTIAL_ERROR_BODIES } from './clubkonnect.status';

/** ClubKonnect endpoint paths. Named so call sites read as intent, not as URLs. */
export const CK_ENDPOINT = {
  walletBalance: '/APIWalletBalanceV1.asp',

  airtime: '/APIAirtimeV1.asp',
  data: '/APIDatabundleV1.asp',
  electricity: '/APIElectricityV1.asp',
  cableTv: '/APICableTVV1.asp',
  betting: '/APIBettingV1.asp',

  verifyElectricity: '/APIVerifyElectricityV1.asp',
  verifyCableTv: '/APIVerifyCableTVV1.asp',
  verifyBetting: '/APIVerifyBettingV1.asp',

  query: '/APIQueryV1.asp',

  dataPlans: '/APIDatabundlePlansV2.asp',
  cablePackages: '/APICableTVPackagesV2.asp',
  discos: '/APIElectricityDiscosV1.asp',
  bettingCompanies: '/APIBettingTypeV2.asp',
} as const;

/** Query parameters, before credentials are added. `undefined` values are dropped. */
export type CkParams = Record<string, string | undefined>;

export interface CkRequestOptions {
  /** Adds `APIKey`. Catalogue endpoints take only a `UserID` and reject the key. */
  readonly withApiKey?: boolean;
}

/**
 * Transport for ClubKonnect.
 *
 * ## What this layer exists to absorb
 *
 * The API predates most conventions a caller would assume. Every operation is a
 * `GET` with parameters in the query string — including the credentials. Success
 * and failure both arrive as HTTP 200. Responses are usually JSON but are served
 * as `text/html`, and some errors are a bare word (`INVALID_CREDENTIALS`) with
 * no JSON at all. Amounts and status codes are strings.
 *
 * All of that is dealt with here, once, so the provider above it can be written
 * as though it were talking to an ordinary API.
 *
 * ## Credentials in the URL
 *
 * Because the API key is a query parameter, the request URL is itself a secret.
 * No log line, metric label or exception detail below carries the URL — they
 * carry the *endpoint path*, which is the useful half and none of the sensitive
 * one. A single `this.logger.error({ url })` added here would publish the API
 * key to the log store, so keep it that way.
 */
@Injectable()
export class ClubKonnectClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(ClubKonnectClient.name);
  }

  /**
   * Issues one request and returns the parsed body.
   *
   * @throws AppException `UPSTREAM_TIMEOUT` when the deadline passes — callers
   *   placing orders must treat that as an *unknown* outcome, not a failure. The
   *   order may well have been accepted.
   */
  async get<T>(endpoint: string, params: CkParams, options: CkRequestOptions = {}): Promise<T> {
    const { baseUrl, userId, apiKey } = this.config.bills.clubkonnect;

    if (!userId || (options.withApiKey !== false && !apiKey)) {
      // Fail closed rather than sending a half-authenticated request that the
      // provider answers with an opaque error.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Bill payments are not configured',
        details: { provider: 'clubkonnect' },
      });
    }

    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set('UserID', userId);
    if (options.withApiKey !== false) {
      url.searchParams.set('APIKey', apiKey);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }

    const operation = `clubkonnect${endpoint.replace(/[/.]/g, '_')}`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(this.config.bills.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      this.logger.error({ err: cause, endpoint, timedOut }, 'ClubKonnect request did not complete');

      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const body = await response.text().catch(() => '');

    if (!response.ok) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });
      this.logger.error(
        { status: response.status, endpoint, body: body.slice(0, 500) },
        'ClubKonnect returned a non-2xx response',
      );

      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider rejected the request',
        details: { providerStatus: response.status },
        // 4xx will fail identically on retry; 5xx may not.
        retryable: response.status >= 500,
      });
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
    return this.parse<T>(body, endpoint);
  }

  /**
   * Turns a 200 response body into a value.
   *
   * Handles the two non-JSON cases the API actually produces: a bare credential
   * error word, and an HTML page (which is what a wrong path or an outage looks
   * like here, since there is no status code to tell us).
   */
  private parse<T>(body: string, endpoint: string): T {
    const trimmed = body.trim();

    if (trimmed === '') {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider returned an empty response',
        retryable: true,
      });
    }

    // Bare error words, quoted or not — `INVALID_CREDENTIALS`, `MISSING_APIKEY`.
    const unquoted = trimmed.replace(/^"|"$/g, '').toUpperCase();
    if (CREDENTIAL_ERROR_BODIES.has(unquoted)) {
      this.logger.error(
        { endpoint, providerError: unquoted },
        'ClubKonnect rejected our credentials',
      );

      // Deliberately not surfaced to the caller as an auth error: it is *our*
      // credentials that are wrong, not theirs, and they can do nothing about it.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Bill payments are temporarily unavailable',
        details: { providerError: unquoted },
      });
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (cause) {
      this.logger.error(
        { endpoint, body: trimmed.slice(0, 500) },
        'ClubKonnect returned a body that is not JSON',
      );

      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider returned an unreadable response',
        cause,
        retryable: true,
      });
    }
  }
}

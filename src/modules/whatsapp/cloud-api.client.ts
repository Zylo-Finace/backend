import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

/** Meta's response to a successful send. */
export interface SendMessageResponse {
  messaging_product: 'whatsapp';
  contacts: { input: string; wa_id: string }[];
  messages: { id: string; message_status?: string }[];
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

/**
 * Meta error codes that are worth retrying.
 *
 * This mapping is the difference between a transient blip healing itself and a
 * message being retried forever against a permanent rejection. Meta's HTTP status
 * is not a reliable guide — they return 400 for both "rate limited, try again"
 * and "this template does not exist" — so the *numeric code* is authoritative.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const RETRYABLE_META_CODES = new Set([
  1, // API_UNKNOWN — transient internal error
  2, // API_SERVICE — temporary outage
  4, // API_TOO_MANY_CALLS — app-level rate limit
  80007, // rate limit hit
  130429, // messaging throughput limit reached
  131048, // spam rate limit hit
  131056, // pair rate limit (too many messages to one recipient)
  133016, // account temporarily unavailable during registration
  368, // temporarily blocked for policy violations
]);

/** Codes meaning the token is dead — retrying is pointless and noisy. */
const AUTH_META_CODES = new Set([
  0, // AuthException
  190, // access token expired/invalidated
  10, // permission denied
  200, // permission error
]);

/**
 * Thin HTTP client for the Meta Cloud API.
 *
 * Deliberately does **not** know about conversations, service windows or the
 * database — it speaks Meta's protocol and translates their failures into our
 * error vocabulary. Business rules live in `MessagingService`; keeping them out
 * of here is what makes this class testable with nothing but `fetch` stubbed.
 */
@Injectable()
export class CloudApiClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(CloudApiClient.name);
  }

  /**
   * Sends a message.
   *
   * @param phoneNumberId Meta's id for the sending business number.
   * @param accessToken   Decrypted token for that number.
   * @param body          A Cloud API message object, already shaped by the caller.
   */
  async sendMessage(
    phoneNumberId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<SendMessageResponse> {
    return this.call<SendMessageResponse>(
      `/${phoneNumberId}/messages`,
      accessToken,
      { messaging_product: 'whatsapp', ...body },
      'send_message',
    );
  }

  /**
   * Marks an inbound message as read (the blue ticks the customer sees).
   *
   * Failures are swallowed by the caller: a read receipt is a courtesy, and
   * failing a request because a tick did not render would be absurd.
   */
  async markAsRead(phoneNumberId: string, accessToken: string, wamid: string): Promise<void> {
    await this.call(
      `/${phoneNumberId}/messages`,
      accessToken,
      { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
      'mark_read',
    );
  }

  /** Resolves a media id to a short-lived, authenticated download URL. */
  async getMediaUrl(
    mediaId: string,
    accessToken: string,
  ): Promise<{ url: string; mimeType: string; fileSize: number }> {
    const media = await this.call<{ url: string; mime_type: string; file_size: number }>(
      `/${mediaId}`,
      accessToken,
      undefined,
      'get_media',
      'GET',
    );

    return { url: media.url, mimeType: media.mime_type, fileSize: media.file_size };
  }

  /** Current status of a business number, for the health/quality display. */
  async getPhoneNumber(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{
    verified_name?: string;
    display_phone_number?: string;
    quality_rating?: string;
    messaging_limit_tier?: string;
  }> {
    return this.call(
      `/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier`,
      accessToken,
      undefined,
      'get_phone_number',
      'GET',
    );
  }

  private async call<T>(
    path: string,
    accessToken: string,
    body: unknown,
    operation: string,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<T> {
    const { graphBaseUrl, graphVersion, httpTimeoutMs } = this.config.whatsapp;
    const url = `${graphBaseUrl}/${graphVersion}${path}`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // An outbound call with no deadline eventually holds a request or a
        // worker open indefinitely when Meta degrades.
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'network_error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'WhatsApp could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });
      throw this.toException(payload as MetaErrorBody, response.status, operation);
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
    return payload as T;
  }

  /**
   * Translates a Meta error into our vocabulary.
   *
   * The specific codes matter to callers: `WHATSAPP_OUTSIDE_SERVICE_WINDOW`
   * tells the messaging layer to fall back to a template, and
   * `WHATSAPP_TOKEN_INVALID` should page someone rather than be retried.
   */
  private toException(body: MetaErrorBody, status: number, operation: string): AppException {
    const error = body?.error ?? {};
    const code = error.code ?? 0;
    const detail = error.error_data?.details ?? error.message ?? `HTTP ${status}`;

    this.logger.error(
      {
        operation,
        httpStatus: status,
        metaCode: code,
        metaSubcode: error.error_subcode,
        metaMessage: error.message,
        // Meta's support asks for this id first when a ticket is raised.
        fbtraceId: error.fbtrace_id,
      },
      'WhatsApp Cloud API returned an error',
    );

    if (AUTH_META_CODES.has(code)) {
      return new AppException(ErrorCode.WHATSAPP_TOKEN_INVALID, {
        message: 'The WhatsApp access token is invalid or expired',
        details: { metaCode: code },
        retryable: false,
      });
    }

    switch (code) {
      // Re-engagement required: the 24-hour window has closed.
      case 131047:
      case 131051:
        return new AppException(ErrorCode.WHATSAPP_OUTSIDE_SERVICE_WINDOW, {
          message: 'This customer can only be reached with an approved template',
          details: { metaCode: code },
          retryable: false,
        });

      case 131026: // recipient cannot receive (not on WhatsApp, or number invalid)
      case 131052:
        return new AppException(ErrorCode.WHATSAPP_RECIPIENT_INVALID, {
          message: 'This number cannot receive WhatsApp messages',
          details: { metaCode: code },
          retryable: false,
        });

      case 132000: // template param count mismatch
      case 132005:
      case 132007:
        return new AppException(ErrorCode.WHATSAPP_TEMPLATE_PARAM_MISMATCH, {
          message: 'The template variables do not match the approved template',
          details: { metaCode: code, detail },
          retryable: false,
        });

      case 132001: // template does not exist / not approved in this language
      case 132012:
      case 132015:
        return new AppException(ErrorCode.WHATSAPP_TEMPLATE_NOT_APPROVED, {
          message: 'The template is not approved for this number and language',
          details: { metaCode: code },
          retryable: false,
        });

      case 131031: // account restricted
        return new AppException(ErrorCode.WHATSAPP_NUMBER_NOT_REGISTERED, {
          message: 'This WhatsApp business account is restricted',
          details: { metaCode: code },
          retryable: false,
        });

      default:
        if (RETRYABLE_META_CODES.has(code) || status >= 500) {
          return new AppException(ErrorCode.WHATSAPP_RATE_LIMITED, {
            message: 'WhatsApp is temporarily rejecting messages; this will be retried',
            details: { metaCode: code },
            retryable: true,
            // Meta does not send Retry-After. This is a conservative default that
            // backs off far enough to clear a throughput limit.
            retryAfterSeconds: 30,
          });
        }

        return new AppException(ErrorCode.WHATSAPP_API_ERROR, {
          message: 'WhatsApp rejected the message',
          details: { metaCode: code, detail },
          retryable: false,
        });
    }
  }
}

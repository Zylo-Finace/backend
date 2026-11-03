import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { HttpHeader } from '../../core/constants/http-header.constants';
import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { SkipResponseEnvelope } from '../../core/decorators/skip-response-envelope.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { HashingService } from '../../infrastructure/security/hashing.service';
import { InboundService } from './inbound.service';
import { parseWebhook, verifyMetaSignature } from './webhook-parser';

/**
 * Meta's WhatsApp webhook.
 *
 * Two endpoints with completely different contracts, both dictated by Meta:
 *
 * - **`GET`** — the subscription handshake. Meta sends `hub.challenge` and
 *   expects the bare value echoed back as `text/plain`. Any wrapping (including
 *   our standard JSON envelope) fails verification, which is why this handler
 *   opts out with `@SkipResponseEnvelope()`.
 * - **`POST`** — event delivery, authenticated solely by `x-hub-signature-256`.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'webhooks/whatsapp', version: '1' })
export class WhatsAppWebhookController {
  constructor(
    private readonly inbound: InboundService,
    private readonly hashing: HashingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppWebhookController.name);
  }

  /**
   * Subscription verification handshake.
   *
   * The verify token is compared in constant time. It is a shared secret, and a
   * naive `===` leaks the length of the matching prefix — enough, with enough
   * attempts, to recover it and register a hostile endpoint.
   */
  @Get()
  @SkipResponseEnvelope()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const expected = this.config.whatsapp.webhookVerifyToken;

    if (mode !== 'subscribe' || !token || !challenge || !expected) {
      throw new AppException(ErrorCode.WEBHOOK_VERIFICATION_FAILED, {
        message: 'Verification failed',
      });
    }

    if (!this.hashing.secureCompare(token, expected)) {
      this.logger.warn('WhatsApp webhook verification attempted with an incorrect token');
      throw new AppException(ErrorCode.WEBHOOK_VERIFICATION_FAILED, {
        message: 'Verification failed',
      });
    }

    this.logger.info('WhatsApp webhook subscription verified');
    // Meta requires the raw challenge string and nothing else.
    return challenge;
  }

  /**
   * Event delivery.
   *
   * Always returns 200 once the signature is valid — including when individual
   * messages fail to store. Meta redelivers the **entire batch** on a non-2xx,
   * so failing the request because one message was malformed would resend the
   * ones that already succeeded, and repeated failures make Meta disable the
   * subscription entirely. Per-item failures are logged, counted and surfaced in
   * the response body instead.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  // Meta expects a fast acknowledgement and treats slow responses as failures.
  @RequestTimeout(10_000)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    if (!rawBody?.length) {
      this.logger.error('WhatsApp webhook received without a raw body; cannot verify signature');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const signature = headerValue(request, HttpHeader.MetaSignature);

    if (!verifyMetaSignature(rawBody, signature, this.config.whatsapp.appSecret)) {
      this.logger.warn(
        { ip: request.ip, hasSignature: Boolean(signature) },
        'Rejected WhatsApp webhook with an invalid signature',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    // Parsed only once the signature proves the bytes came from Meta.
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    const parsed = parseWebhook(payload);

    if (parsed.messages.length === 0 && parsed.statuses.length === 0) {
      // Meta sends assorted account-level notifications we do not model. They
      // must still be acknowledged.
      return { received: true };
    }

    const result = await this.inbound.ingest(parsed);

    this.logger.info(
      {
        stored: result.messagesStored,
        duplicates: result.messagesDuplicate,
        statuses: result.statusesApplied,
        unroutable: result.unroutable,
      },
      'WhatsApp webhook processed',
    );

    return { received: true };
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

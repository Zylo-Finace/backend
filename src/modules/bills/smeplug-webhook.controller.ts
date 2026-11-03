import { timingSafeEqual } from 'node:crypto';

import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { BillOrderStatus } from './bills-provider.interface';
import { SmePlugProvider } from './smeplug.provider';

/**
 * Inbound SMEPlug transaction notifications.
 *
 * ## Security model, and its limits
 *
 * **SMEPlug does not sign its webhooks.** There is no HMAC, no timestamp, no
 * shared secret in the payload and no published source addresses — the dashboard
 * accepts a URL and posts JSON to it. That is the provider's design, not an
 * oversight here, and it cannot be verified into existence.
 *
 * Two things follow, and both are deliberate:
 *
 *  1. **The URL is the credential.** A long random segment
 *     (`SMEPLUG_WEBHOOK_SECRET`) is embedded in the path we register, and
 *     compared in constant time. It is the only authentication available.
 *  2. **The webhook is treated as advisory.** It may move an order we already
 *     placed to a terminal state; it may not create one, credit a wallet, or
 *     name an amount. Even a forged body that guessed the URL can therefore only
 *     mark a real order — one we ourselves sent upstream, under a reference we
 *     generated — as delivered or failed.
 *
 * The primary result of a purchase is the synchronous HTTP response, not this.
 * SMEPlug answers orders inline, so a lost webhook costs nothing.
 *
 * ## Response discipline
 *
 * A parsed-but-unusable notification is acknowledged with 200 rather than
 * retried: it names no order of ours, and no number of redeliveries will change
 * that.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'webhooks/smeplug', version: '1' })
export class SmePlugWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly provider: SmePlugProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmePlugWebhookController.name);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global budget: a slow acknowledgement to a provider that
  // gives us no other guarantees is worse than a fast one.
  @RequestTimeout(8_000)
  handle(
    @Param('token') token: string,
    @Body() payload: unknown,
  ): { received: true; status: string } {
    this.assertToken(token);

    const callback = this.provider.parseCallback(payload);

    if (!callback.reference) {
      // No `customer_reference` means nothing to match. Logged loudly — it is
      // either a probe against the URL or a change in their payload — and
      // acknowledged, because a retry would arrive just as unusable.
      this.logger.error(
        { providerOrderId: callback.providerOrderId, statusCode: callback.statusCode },
        'SMEPlug notification carried no customer reference; cannot match an order',
      );
      return { received: true, status: 'unmatched' };
    }

    // Recorded, not acted upon. The synchronous purchase response is the
    // authority on whether a bundle was delivered; this confirms it, and catches
    // the rare later reversal.
    const level = callback.status === BillOrderStatus.Cancelled ? 'warn' : 'info';
    this.logger[level](
      {
        reference: callback.reference,
        providerOrderId: callback.providerOrderId,
        status: callback.status,
        statusCode: callback.statusCode,
      },
      'SMEPlug transaction notification',
    );

    return { received: true, status: callback.status };
  }

  /**
   * Constant-time comparison of the path secret.
   *
   * Length is checked first because `timingSafeEqual` throws on a mismatch; the
   * length of the token is not itself a secret. The failure gives no detail —
   * explaining *why* a token was rejected is a guessing aid.
   */
  private assertToken(token: string): void {
    const expected = this.config.bills.smeplug.webhookSecret;

    if (!expected) {
      // Fail closed. An unconfigured secret must never mean "accept everything",
      // which on an unsigned webhook would mean accepting anything at all.
      this.logger.error('SMEPlug webhook secret is not configured; rejecting notification');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Not found',
      });
    }

    const provided = token ?? '';
    const ok =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));

    if (!ok) {
      this.logger.warn(
        { tokenLength: provided.length },
        'Rejected SMEPlug webhook with a bad token',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Not found',
      });
    }
  }
}

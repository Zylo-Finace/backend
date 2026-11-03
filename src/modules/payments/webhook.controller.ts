import { Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { FundingService } from './funding.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.interface';

/** Paystack's signature header. */
const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

/**
 * Inbound payment-provider webhooks.
 *
 * ## Security model
 *
 * This endpoint is `@Public()` — the provider holds no token — so the **signature
 * is the only authentication**. Everything about the handler follows from that:
 *
 * - Verification happens before the payload is inspected, parsed or stored.
 *   A body that fails the HMAC is never given to any parser.
 * - It uses the **raw bytes**. `JSON.parse` then `JSON.stringify` reorders keys
 *   and drops whitespace, producing a different HMAC and failing every legitimate
 *   webhook. `rawBody: true` in `main.ts` is what makes the original buffer
 *   available here.
 * - Failure returns 401 with no detail. Explaining *why* a signature was rejected
 *   is a forgery tutorial.
 *
 * ## Response discipline
 *
 * Providers treat a non-2xx as "retry" and repeatedly-failing endpoints as
 * "disable the subscription". The handler is therefore fast, and it is honest:
 * a genuine processing failure returns 5xx *on purpose*, because the provider's
 * retry is the recovery mechanism and our processing is idempotent. Returning 200
 * on failure would strand the customer's money with no second chance.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'webhooks', version: '1' })
export class WebhookController {
  constructor(
    private readonly funding: FundingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookController.name);
  }

  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global budget: providers give us only seconds before they
  // record a timeout and retry, and a slow ack is worse than a fast failure.
  @RequestTimeout(8_000)
  async paystack(@Req() request: Request): Promise<{ received: true; status: string }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    if (!rawBody?.length) {
      // Without the raw buffer we cannot verify anything, and accepting an
      // unverified funding instruction is not an option.
      this.logger.error('Webhook received without a raw body; signature cannot be verified');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const signature = headerValue(request, PAYSTACK_SIGNATURE_HEADER);

    if (!this.provider.verifySignature(rawBody, signature)) {
      this.logger.warn(
        { ip: request.ip, hasSignature: Boolean(signature), bytes: rawBody.length },
        'Rejected webhook with an invalid signature',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    // Parsed only after the signature proves the bytes came from the provider.
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    const event = this.provider.parseEvent(payload);

    const outcome = await this.funding.handle(payload, signature, event);

    return { received: true, status: outcome.status.toLowerCase() };
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

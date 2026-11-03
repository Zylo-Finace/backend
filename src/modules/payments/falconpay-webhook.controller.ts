import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Req,
  VERSION_NEUTRAL,
  forwardRef,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { BillOrderStatus } from '../bills/bills-provider.interface';
import {
  isFalconPayBillEvent,
  parseFalconPayBillCallback,
} from '../bills/falconpay-bills.provider';
import { RampNairaService } from '../ramp/ramp.naira';
import {
  FALCONPAY_SIGNATURE_HEADER,
  FALCONPAY_TIMESTAMP_HEADER,
  FalconPayProvider,
} from './falconpay.provider';
import { PayoutEventStatus } from './payout-provider.interface';
import { PayoutService } from './payout.service';

/**
 * FalconPay payout status webhooks.
 *
 * ## Why this route is version-neutral
 *
 * The path is `/api/falconpay/webhook`, not `/api/v1/…`, because that is the URL
 * registered with FalconPay (`FALCONPAY_WEBHOOK_URL`). A webhook URL is held by
 * a third party and changing it is a manual dashboard operation, so it does not
 * get to move when our API version does. Our own clients are versioned; their
 * callback is a fixed address.
 *
 * ## Security model
 *
 * This endpoint is `@Public()` — FalconPay holds no token — so the **signature
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
 * An accepted forgery here settles a payout that never happened — it debits a
 * customer for money they still have — so this is not a place to be lenient
 * about a missing or malformed signature.
 *
 * ## Transfers and bills share this URL
 *
 * FalconPay allows one webhook per environment, so `bill.completed` /
 * `bill.failed` arrive here too, signed with the same secret. They are split off
 * after verification and never reach `PayoutService` — a bill reference has no
 * payout row, and treating it as one would only produce noise.
 *
 * ## Response discipline
 *
 * FalconPay treats a non-2xx as "retry". The handler is therefore fast, and it
 * is honest: a genuine processing failure returns 5xx *on purpose*, because
 * their retry is the recovery mechanism and our processing is idempotent.
 * Returning 200 on failure would strand a customer's funds in a hold that
 * nothing would ever close.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'falconpay', version: VERSION_NEUTRAL })
export class FalconPayWebhookController {
  constructor(
    private readonly payouts: PayoutService,
    // The concrete adapter, not `PAYOUT_PROVIDER`: with a fallback configured
    // that token is a router, which refuses to verify signatures by design.
    private readonly provider: FalconPayProvider,
    @Optional()
    @Inject(forwardRef(() => RampNairaService))
    private readonly rampNaira: RampNairaService | undefined,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FalconPayWebhookController.name);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global budget: providers give us only seconds before they
  // record a timeout and retry, and a slow ack is worse than a fast failure.
  @RequestTimeout(8_000)
  async webhook(@Req() request: Request): Promise<{ received: true; status: string }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    if (!rawBody?.length) {
      // Without the raw buffer we cannot verify anything, and acting on an
      // unverified payout instruction is not an option.
      this.logger.error('Payout webhook received without a raw body; signature cannot be verified');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const signature = headerValue(request, FALCONPAY_SIGNATURE_HEADER);
    const timestamp = headerValue(request, FALCONPAY_TIMESTAMP_HEADER);

    if (!this.provider.verifySignature(rawBody, signature, timestamp)) {
      this.logger.warn(
        { ip: request.ip, hasSignature: Boolean(signature), bytes: rawBody.length },
        'Rejected payout webhook with an invalid signature',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    // Parsed only after the signature proves the bytes came from the provider.
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));

    if (isFalconPayBillEvent(payload)) {
      const bill = parseFalconPayBillCallback(payload);
      // Recorded, not acted upon: the purchase flow already holds the pay /
      // status response, and a late reversal needs a human, not an automatic
      // refund off a webhook.
      const level =
        bill.status === BillOrderStatus.Failed || bill.status === BillOrderStatus.Cancelled
          ? 'warn'
          : 'info';
      this.logger[level](
        {
          reference: bill.reference,
          providerOrderId: bill.providerOrderId,
          status: bill.status,
          product: bill.raw.product,
        },
        'FalconPay bill notification',
      );
      return { received: true, status: bill.status };
    }

    const event = this.provider.parseEvent(payload);

    const outcome = await this.payouts.handleWebhook(payload, signature, event);

    if (
      this.rampNaira &&
      (event.status === PayoutEventStatus.Completed || event.status === PayoutEventStatus.Failed)
    ) {
      await this.rampNaira
        .onPayoutTerminal({
          reference: event.reference,
          status: event.status === PayoutEventStatus.Completed ? 'completed' : 'failed',
          message: event.message,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            { err: err instanceof Error ? err.message : String(err), reference: event.reference },
            'Ramp bank-send WhatsApp notify failed',
          );
        });
    }

    return { received: true, status: outcome.status.toLowerCase() };
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

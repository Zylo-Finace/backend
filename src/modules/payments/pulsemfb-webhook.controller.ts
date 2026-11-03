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

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { RampNairaService } from '../ramp/ramp.naira';
import { FundingService } from './funding.service';
import { PayoutEventStatus } from './payout-provider.interface';
import { PayoutService } from './payout.service';
import { PulseMfbPayoutProvider } from './pulsemfb-payout.provider';
import {
  PULSEMFB_SIGNATURE_HEADER,
  PulseMfbProvider,
  PulseTransferDirection,
  type PulseWebhookPayload,
  classifyTransferEvent,
} from './pulsemfb.provider';

/**
 * Pulse MFB webhooks — account provisioning, inbound credits and payout status.
 *
 * ## Why one controller for three concerns
 *
 * Pulse registers **one** webhook URL per API client and posts every event to
 * it. Splitting this into an inbound controller and a payout controller, as
 * PayVessel and FalconPay have, is not available: there is only one address to
 * register. So the split happens here instead, after verification.
 *
 * ## Why the route is version-neutral
 *
 * The path is `/api/pulsemfb/webhook`, not `/api/v1/…`, because that is the URL
 * registered with Pulse. A webhook URL is held by a third party and changing it
 * is a dashboard operation, so it does not get to move when our API version
 * does. Our own clients are versioned; their callback is a fixed address.
 *
 * ## Security model
 *
 * `@Public()` — Pulse holds no token of ours — so the **signature is the only
 * authentication**, and everything follows from that:
 *
 * - Verification runs before the payload is inspected, parsed or stored.
 * - It uses the **raw bytes**, not a re-serialisation of the parsed body.
 *   `rawBody: true` in `main.ts` is what makes the original buffer available.
 * - Rejection returns 401 with no detail. Explaining *why* a signature failed is
 *   a forgery tutorial.
 *
 * An accepted forgery here credits a wallet with money that never arrived, or
 * settles a payout that never happened. Neither is a place to be lenient about a
 * missing signature.
 *
 * ## Response discipline
 *
 * Pulse retries a non-2xx up to five times. The handler is therefore fast, and
 * honest: a genuine processing failure returns 5xx *on purpose*, because their
 * retry is the recovery mechanism and our processing is idempotent. Returning
 * 200 on failure would strand a customer's funds in a hold nothing would close.
 *
 * A payload that is well-formed but names nothing of ours is acknowledged with
 * 200 — no number of redeliveries will make it match.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'pulsemfb', version: VERSION_NEUTRAL })
export class PulseMfbWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly accounts: PulseMfbProvider,
    private readonly payoutProvider: PulseMfbPayoutProvider,
    private readonly funding: FundingService,
    private readonly payouts: PayoutService,
    @Optional()
    @Inject(forwardRef(() => RampNairaService))
    private readonly rampNaira: RampNairaService | undefined,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PulseMfbWebhookController.name);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global budget: providers give us only seconds before they
  // record a timeout and retry, and a slow ack is worse than a fast failure.
  @RequestTimeout(8_000)
  async webhook(@Req() request: Request): Promise<{ received: true; status: string }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    if (!rawBody?.length) {
      // Without the raw buffer nothing can be verified, and acting on an
      // unverified money instruction is not an option.
      this.logger.error('Pulse MFB webhook received without a raw body; cannot verify signature');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const signature = headerValue(request, PULSEMFB_SIGNATURE_HEADER);

    if (!this.accounts.verifySignature(rawBody, signature)) {
      this.logger.warn(
        { ip: request.ip, hasSignature: Boolean(signature), bytes: rawBody.length },
        'Rejected Pulse MFB webhook with an invalid signature',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    // Parsed only after the signature proves the bytes came from Pulse.
    const payload = JSON.parse(rawBody.toString('utf8')) as PulseWebhookPayload;
    const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';

    // `transfer.*` is the ambiguous one: Pulse emits the same event whether
    // money left our float or arrived in an account we issued. Everything else
    // is unambiguous from its name alone.
    if (eventType.startsWith('transfer.')) {
      return this.handleTransfer(payload, eventType, signature);
    }

    return this.handleInbound(payload, eventType, signature);
  }

  /**
   * Routes a transfer event by direction.
   *
   * The classification is on the debit account, not on the reference — see
   * {@link classifyTransferEvent} for why.
   */
  private async handleTransfer(
    payload: PulseWebhookPayload,
    eventType: string,
    signature: string | undefined,
  ): Promise<{ received: true; status: string }> {
    const direction = classifyTransferEvent(payload, this.config.pulsemfb.debitAccountNumber);

    switch (direction) {
      case PulseTransferDirection.Outbound: {
        const event = this.payoutProvider.parseEvent(payload);
        const outcome = await this.payouts.handleWebhook(payload, signature, event);
        if (
          this.rampNaira &&
          (event.status === PayoutEventStatus.Completed ||
            event.status === PayoutEventStatus.Failed)
        ) {
          await this.rampNaira
            .onPayoutTerminal({
              reference: event.reference,
              status: event.status === PayoutEventStatus.Completed ? 'completed' : 'failed',
              message: event.message,
            })
            .catch((err: unknown) => {
              this.logger.warn(
                {
                  err: err instanceof Error ? err.message : String(err),
                  reference: event.reference,
                },
                'Ramp bank-send WhatsApp notify failed',
              );
            });
        }
        return { received: true, status: outcome.status.toLowerCase() };
      }

      case PulseTransferDirection.Inbound:
        return this.handleInbound(payload, eventType, signature);

      case PulseTransferDirection.Unrelated:
      default:
        // Neither side is an account of ours. Acknowledged rather than retried:
        // it will be just as unmatched on redelivery. Logged at warn because the
        // realistic cause is a misconfigured `PULSEMFB_DEBIT_ACCOUNT_NUMBER`,
        // which would silently strand every payout webhook.
        this.logger.warn(
          { eventType, reference: payload.data?.reference },
          'Pulse MFB transfer event matched neither our float nor an issued account',
        );
        return { received: true, status: 'unmatched' };
    }
  }

  /** Account assignments and inbound credits, both handled by `FundingService`. */
  private async handleInbound(
    payload: PulseWebhookPayload,
    eventType: string,
    signature: string | undefined,
  ): Promise<{ received: true; status: string }> {
    const event = this.accounts.parseEvent(payload);

    const outcome = await this.funding.handle(payload, signature, event, this.accounts.name);

    this.logger.info({ eventType, kind: event.kind }, 'Pulse MFB event processed');

    return { received: true, status: outcome.status.toLowerCase() };
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

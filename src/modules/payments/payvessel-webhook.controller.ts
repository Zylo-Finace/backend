import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '../../core/decorators/public.decorator';
import { RequestTimeout } from '../../core/decorators/request-timeout.decorator';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { FundingService } from './funding.service';
import { PayVesselProvider } from './payvessel.provider';

/**
 * PayVessel's signature header.
 *
 * The `HTTP_` prefix is unusual — it is the CGI-style name, which PayVessel
 * sends literally rather than as a conventional `X-` header. Node lower-cases
 * every inbound header name, so the lookup below is lower-case too.
 */
const SIGNATURE_HEADER = 'http_payvessel_http_signature';

/**
 * Inbound PayVessel webhooks.
 *
 * ## Security model
 *
 * `@Public()` — PayVessel holds no token of ours — so the **signature is the
 * authentication**, with the source address as a second, independent check.
 *
 * - Verification happens before the payload is inspected, parsed or stored. A
 *   body that fails the HMAC is never given to any parser.
 * - It uses the **raw bytes**. `JSON.parse` then `JSON.stringify` reorders keys
 *   and drops whitespace, producing a different HMAC and failing every
 *   legitimate delivery. `rawBody: true` in `main.ts` is what makes the original
 *   buffer available here.
 * - The IP allowlist is checked *after* the signature, deliberately. A valid
 *   signature from an unexpected address is a different problem — a proxy change
 *   or a provider migration — from an invalid one, and logging them identically
 *   would hide it.
 * - Failure returns 401 with no detail. Explaining *why* a signature was
 *   rejected is a forgery tutorial.
 *
 * ## Response discipline
 *
 * PayVessel retries any non-2xx for up to 24 hours and expects an answer within
 * ten seconds. The handler is therefore fast, and it is honest: a genuine
 * processing failure returns 5xx *on purpose*, because their retry is the
 * recovery mechanism and our processing is idempotent. Returning 200 on failure
 * would strand the customer's money with no second chance.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'webhooks', version: '1' })
export class PayVesselWebhookController {
  constructor(
    private readonly funding: FundingService,
    private readonly provider: PayVesselProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PayVesselWebhookController.name);
  }

  @Post('payvessel')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global budget: PayVessel records a timeout at ten seconds
  // and a slow acknowledgement is worse than a fast failure.
  @RequestTimeout(8_000)
  async handle(@Req() request: Request): Promise<{ received: true; status: string }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    if (!rawBody?.length) {
      // Without the raw buffer we cannot verify anything, and accepting an
      // unverified funding instruction is not an option.
      this.logger.error('Webhook received without a raw body; signature cannot be verified');
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const signature = headerValue(request, SIGNATURE_HEADER);

    if (!this.provider.verifySignature(rawBody, signature)) {
      this.logger.warn(
        { ip: request.ip, hasSignature: Boolean(signature), bytes: rawBody.length },
        'Rejected PayVessel webhook with an invalid signature',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    const source = sourceIp(request);

    if (!this.provider.isTrustedSource(source)) {
      // A correct signature from an unlisted address almost always means our
      // allowlist is stale, not that a secret leaked — but it is not this
      // handler's job to decide which, so it refuses and says so loudly.
      this.logger.error(
        { ip: source },
        'PayVessel webhook carried a valid signature from an unlisted address; ' +
          'check PAYVESSEL_WEBHOOK_IPS and TRUST_PROXY_HOPS',
      );
      throw new AppException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'Signature verification failed',
      });
    }

    // Parsed only after the signature proves the bytes came from PayVessel.
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    const event = this.provider.parseEvent(payload);

    const outcome = await this.funding.handle(payload, signature, event, this.provider.name);

    return { received: true, status: outcome.status.toLowerCase() };
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The address the request actually came from.
 *
 * `request.ip` already honours Express's `trust proxy` setting, which the app
 * configures from `TRUST_PROXY_HOPS`. Reading `X-Forwarded-For` directly would
 * bypass that and accept whatever a caller claimed.
 */
function sourceIp(request: Request): string | undefined {
  return request.ip ?? request.socket.remoteAddress ?? undefined;
}

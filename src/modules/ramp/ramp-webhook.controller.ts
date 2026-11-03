import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '../../core/decorators/public.decorator';
import { SkipResponseEnvelope } from '../../core/decorators/skip-response-envelope.decorator';
import { getRampConfig, isRampEnabled } from './ramp.config';
import { RampCommandsService } from './ramp.commands';
import { RampWhatsAppService } from './ramp.whatsapp';

/**
 * Meta WhatsApp webhook for the BANJEE USDC ↔ NGN ramp.
 *
 * Path: `/api/whatsapp/webhook` (VERSION_NEUTRAL + global `api` prefix).
 * Separate from the Phase-4 tenant WhatsApp module.
 */
@ApiExcludeController()
@Public()
@SkipResponseEnvelope()
@Controller({ path: 'whatsapp', version: VERSION_NEUTRAL })
export class RampWebhookController {
  constructor(
    private readonly commands: RampCommandsService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampWebhookController.name);
  }

  /** Meta webhook verification */
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): void {
    const { whatsapp } = getRampConfig();

    if (mode === 'subscribe' && token === whatsapp.verifyToken) {
      this.logger.info('[zylo-ramp] webhook verified');
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  }

  /** Inbound WhatsApp messages — ACK immediately, process async. */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  receive(@Req() req: Request): { ok: true } {
    void this.processInbound(req.body);
    return { ok: true };
  }

  private async processInbound(body: unknown): Promise<void> {
    if (!isRampEnabled()) {
      this.logger.warn(
        '[zylo-ramp] inbound ignored — ramp disabled (set WA_RAMP_ENABLED=true and WHATSAPP_TOKEN)',
      );
      return;
    }

    try {
      const messages = this.whatsapp.extractInboundMessages(body);
      if (messages.length === 0) {
        this.logger.debug('[zylo-ramp] inbound with no messages (status/echo?)');
        return;
      }

      for (const msg of messages) {
        this.logger.info(
          {
            from: msg.from,
            text: msg.text,
            buttonId: msg.buttonId,
            phoneNumberId: msg.phoneNumberId,
          },
          '[zylo-ramp] inbound',
        );
        const sendOpts = msg.phoneNumberId ? { phoneNumberId: msg.phoneNumberId } : {};
        try {
          const replies = await this.commands.handleRampIncoming({
            from: msg.from,
            text: msg.text,
            buttonId: msg.buttonId,
            contactName: msg.contactName,
            phoneNumberId: msg.phoneNumberId,
            flowPin: msg.flowPin,
            flowOnboard: msg.flowOnboard,
          });
          await this.whatsapp.dispatchReplies(msg.from, replies, sendOpts);
        } catch (inner) {
          const message = inner instanceof Error ? inner.message : String(inner);
          this.logger.error(
            { err: message, from: msg.from, text: msg.text },
            '[zylo-ramp] message handle failed',
          );
          try {
            await this.whatsapp.sendText(
              msg.from,
              'Sorry — ramp hit an error. If this keeps happening, the operator needs to run DB migrate.',
              sendOpts,
            );
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, '[zylo-ramp] webhook handler error');
    }
  }
}

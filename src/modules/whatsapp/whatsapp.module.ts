import { Module } from '@nestjs/common';

import { CloudApiClient } from './cloud-api.client';
import { InboundService } from './inbound.service';
import { MessagingService } from './messaging.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

/**
 * The Meta WhatsApp Cloud API integration.
 *
 * `MessagingService` is exported so other modules can send — the wallet module
 * will notify a customer when funds land, and automation will reply to commands.
 * Nothing outside this module talks to Meta directly, so the service-window rule
 * and the error mapping cannot be bypassed by a caller in a hurry.
 */
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [CloudApiClient, MessagingService, InboundService],
  exports: [MessagingService],
})
export class WhatsAppModule {}
